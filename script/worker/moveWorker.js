// worker/moveWorker.js
import init, { get_valid_moves, apply_move, search, search_with_history, set_root_eval_debug } from "../engine/pkg/chess_engine.js";

// WASM initialisieren (einmalig); alle Worker-Aktionen warten darauf.
const wasmReady = init().catch((err) => {
    console.error("WASM init failed:", err);
    throw err;
});

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const BOOK_MIN_SCORE_RATIO = 0.2;
const BOOK_WEIGHT_POWER = 0.75;
const openingBookUrls = [
    new URL("../engine/openingBook/opening_book_100000.json", import.meta.url),
    new URL("../engine/openingBook/opening_book_50000.json", import.meta.url),
    new URL("../engine/openingBook/opening_book_20000.json", import.meta.url),
    new URL("../engine/openingBook/opening_book_10000.json", import.meta.url),
    new URL("../engine/openingBook/opening_book_5000.json", import.meta.url),
    new URL("../engine/openingBook/opening_book_1000.json", import.meta.url),
    // Zweite lokale Quelle (falls vorhanden) zur Erweiterung der Variantenbasis.
    new URL("../../src/book/opening_book_1000.json", import.meta.url)
];

// Was: Fuehrt `parseUci` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function parseUci(uci) {
    if (typeof uci !== "string") return null;
    const s = uci.trim();
    if (s.length !== 4 && s.length !== 5) return null;
    const from = lanToField(s.slice(0, 2));
    const to = lanToField(s.slice(2, 4));
    if (from === null || to === null) return null;
    const promo = s.length === 5 ? s[4] : "";
    return { from, to, promo };
}

// Was: Fuehrt `applyUciMove` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function applyUciMove(fen, uci) {
    const parsed = parseUci(uci);
    if (!parsed) return null;
    const nextFen = apply_move(fen, parsed.from, parsed.to, parsed.promo || "");
    if (!nextFen || nextFen === fen) return null;
    return nextFen;
}

// Was: Fuehrt `fenToBookKey` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function fenToBookKey(fen) {
    const parts = String(fen || "").trim().split(/\s+/);
    if (parts.length < 4) return "";
    return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

// Was: Fuehrt `mergeMovesInto` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function mergeMovesInto(targetMoves, sourceMoves) {
    if (!sourceMoves || typeof sourceMoves !== "object") return;
    for (const uci in sourceMoves) {
        const raw = sourceMoves[uci];
        const score = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(score) || score <= 0) continue;
        targetMoves[uci] = (targetMoves[uci] || 0) + score;
    }
}

// Was: Fuehrt `mergeHistoryBooks` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function mergeHistoryBooks(bookList) {
    const merged = Object.create(null);
    for (const source of bookList) {
        if (!source || typeof source !== "object") continue;
        for (const history in source) {
            const entry = source[history];
            if (!entry || typeof entry !== "object" || !entry.moves) continue;
            if (!merged[history]) {
                merged[history] = { moves: Object.create(null) };
            }
            mergeMovesInto(merged[history].moves, entry.moves);
        }
    }
    return merged;
}

// Was: Fuehrt `historyPly` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function historyPly(history) {
    if (!history) return 0;
    return String(history).trim().split(/\s+/).filter(Boolean).length;
}

// Was: Fuehrt `resolveHistoryFen` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function resolveHistoryFen(history, fenByHistory) {
    if (fenByHistory.has(history)) {
        return fenByHistory.get(history);
    }
    if (!history) {
        fenByHistory.set("", START_FEN);
        return START_FEN;
    }
    const text = String(history).trim();
    if (!text) {
        fenByHistory.set("", START_FEN);
        return START_FEN;
    }
    const lastSpace = text.lastIndexOf(" ");
    const parent = lastSpace >= 0 ? text.slice(0, lastSpace) : "";
    const move = lastSpace >= 0 ? text.slice(lastSpace + 1) : text;
    const parentFen = resolveHistoryFen(parent, fenByHistory);
    if (!parentFen) {
        fenByHistory.set(history, null);
        return null;
    }
    const nextFen = applyUciMove(parentFen, move);
    if (!nextFen) {
        fenByHistory.set(history, null);
        return null;
    }
    fenByHistory.set(history, nextFen);
    return nextFen;
}

// Was: Fuehrt `buildPositionBook` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function buildPositionBook(historyBook) {
    const positionBook = Object.create(null);
    const fenByHistory = new Map();
    fenByHistory.set("", START_FEN);

    const keys = Object.keys(historyBook).sort((a, b) => historyPly(a) - historyPly(b));
    for (const history of keys) {
        const entry = historyBook[history];
        if (!entry || typeof entry !== "object" || !entry.moves) continue;

        const fen = resolveHistoryFen(history, fenByHistory);
        if (!fen) continue;

        const key = fenToBookKey(fen);
        if (!key) continue;

        if (!positionBook[key]) {
            positionBook[key] = {
                moves: Object.create(null),
                transpositions: 0
            };
        }
        mergeMovesInto(positionBook[key].moves, entry.moves);
        positionBook[key].transpositions += 1;
    }
    return positionBook;
}

// Was: Fuehrt `loadMergedHistoryBook` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
async function loadMergedHistoryBook() {
    const loaded = (await Promise.all(openingBookUrls.map(async (url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || typeof data !== "object") return null;
            return { url: url.pathname, data };
        } catch (_err) {
            // Einzeldatei optional: Fehler ignorieren und nächste testen.
            return null;
        }
    }))).filter(Boolean);
    if (!loaded.length) return null;
    const merged = mergeHistoryBooks(loaded.map((x) => x.data));
    console.log(
        "Opening book loaded:",
        loaded.map((x) => x.url).join(", "),
        "| merged positions:",
        Object.keys(merged).length
    );
    return merged;
}

// Was: Initialisiert `openingBookReady` als einmaliges Laden/Mergen/Indexieren der Buchdaten.
// Warum: Verhindert wiederholte I/O- und Aufbaukosten pro Suche und hält den Worker-Pfad schlank.
// Kosten: Einmaliger Startaufwand, danach nur Promise-Resolve auf bereits vorbereitete Daten.
const openingBookReady = (async () => {
    try {
        await wasmReady;
        const historyBook = await loadMergedHistoryBook();
        if (!historyBook) {
            console.warn("Opening book not available");
            return null;
        }
        const positionBook = buildPositionBook(historyBook);
        return { historyBook, positionBook };
    } catch (err) {
        console.warn("Opening book load/build error:", err);
        return null;
    }
})();

const bookState = {
    active: true,
    gameId: null,
    lastHistory: ""
};

// Such-IDs für saubere Zuordnung von Progress-Events.
let searchSeq = 0;
let activeSearchId = 0;

// Was: Fuehrt `toSafeInt` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function toSafeInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// Was: Leitet Engine-Fortschritt als Worker-Message an den Main-Thread weiter.
// Warum: Entkoppelt Suchlauf und UI-Update ohne Zusatzsuche oder Polling auf Main-Thread-Seite.
// Kosten: Sehr geringe, ereignisgetriebene Message-Kosten pro Fortschrittsmeldung.
globalThis.__engine_progress = (depth, nodesCompleted, nodesTotal, elapsedMs) => {
    if (!activeSearchId) return;
    // Progress nur für die aktuell laufende Suche senden.
    self.postMessage({
        action: "search-progress",
        searchId: activeSearchId,
        depth: toSafeInt(depth),
        nodes: toSafeInt(nodesTotal),
        nodes_completed: toSafeInt(nodesCompleted),
        nodes_total: toSafeInt(nodesTotal),
        time_ms: toSafeInt(elapsedMs)
    });
};

// Was: Fuehrt `normalizeHistory` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function normalizeHistory(history) {
    return String(history || "").trim().replace(/\s+/g, " ");
}

// Was: Fuehrt `shouldResetBook` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function shouldResetBook(gameId, history) {
    if (bookState.gameId !== gameId) return true;
    if (history.length < bookState.lastHistory.length) return true;
    if (bookState.lastHistory && !history.startsWith(bookState.lastHistory)) return true;
    return false;
}

// Was: Fuehrt `lanToField` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function lanToField(lan) {
    if (!lan || lan.length !== 2) return null;
    const file = lan.charCodeAt(0) - 97; // 'a'
    const rank = lan.charCodeAt(1) - 49; // '1'
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return rank * 8 + file;
}

// Was: Fuehrt `collectLegalBookMoves` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function collectLegalBookMoves(fen, moves) {
    const entries = [];
    for (const uci in moves) {
        const raw = moves[uci];
        const score = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(score) || score <= 0) continue;
        if (!applyUciMove(fen, uci)) continue;
        entries.push({ uci, score });
    }
    return entries;
}

// Was: Fuehrt `filterBookCandidates` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function filterBookCandidates(entries) {
    if (!entries.length) return entries;
    let bestScore = 0;
    for (const entry of entries) {
        if (entry.score > bestScore) bestScore = entry.score;
    }
    if (bestScore <= 0) return entries;
    const threshold = bestScore * BOOK_MIN_SCORE_RATIO;
    const filtered = entries.filter((entry) => entry.score >= threshold);
    return filtered.length ? filtered : entries;
}

// Was: Fuehrt `pickWeightedBookMove` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function pickWeightedBookMove(entries) {
    if (!entries.length) return "";
    let weightSum = 0;
    for (const entry of entries) {
        weightSum += Math.pow(entry.score, BOOK_WEIGHT_POWER);
    }
    if (!(weightSum > 0)) {
        const idx = Math.floor(Math.random() * entries.length);
        return entries[idx].uci;
    }
    let r = Math.random() * weightSum;
    for (const entry of entries) {
        r -= Math.pow(entry.score, BOOK_WEIGHT_POWER);
        if (r <= 0) return entry.uci;
    }
    return entries[entries.length - 1].uci;
}

// Was: Fuehrt `getBookEntry` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function getBookEntry(bookData, fen, history) {
    if (!bookData) return null;
    const posKey = fenToBookKey(fen);
    const posEntry = posKey ? bookData.positionBook[posKey] : null;
    if (posEntry && posEntry.moves) return posEntry;
    const historyEntry = bookData.historyBook[history];
    if (historyEntry && historyEntry.moves) return historyEntry;
    return null;
}

// Was: Fuehrt `getBookMove` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
async function getBookMove(fen, historyUci, gameId, bookEnabled) {
    if (!bookEnabled) return null;

    const history = normalizeHistory(historyUci);
    if (shouldResetBook(gameId, history)) {
        bookState.active = true;
        bookState.gameId = gameId;
    }
    bookState.lastHistory = history;

    if (!bookState.active) return null;

    const bookData = await openingBookReady;
    if (!bookData) {
        bookState.active = false;
        return null;
    }
    const entry = getBookEntry(bookData, fen, history);
    if (!entry || !entry.moves) {
        bookState.active = false;
        return null;
    }

    const legalEntries = collectLegalBookMoves(fen, entry.moves);
    if (!legalEntries.length) {
        bookState.active = false;
        return null;
    }
    const candidates = filterBookCandidates(legalEntries);
    const selectedMove = pickWeightedBookMove(candidates);
    if (!selectedMove) {
        bookState.active = false;
        return null;
    }
    return selectedMove;
}

// Was: Fuehrt `collectMoves` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function collectMoves(fen) {
    const moves = [];
    for (let from = 0; from < 64; from++) {
        const targets = Array.from(get_valid_moves(fen, from));
        if (!targets.length) continue;
        for (const to of targets) {
            moves.push([from, to]);
        }
    }
    return moves;
}

// Was: Fuehrt `parseBoard` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function parseBoard(fen) {
    const boardPart = String(fen || "").split(/\s+/)[0];
    if (!boardPart) return null;
    const ranks = boardPart.split("/");
    if (ranks.length !== 8) return null;

    const board = new Array(64).fill(null);
    let row = 7;
    for (const rank of ranks) {
        let col = 0;
        for (const ch of rank) {
            if (ch >= "1" && ch <= "8") {
                col += Number(ch);
            } else {
                if (col < 0 || col > 7) return null;
                board[row * 8 + col] = ch;
                col += 1;
            }
        }
        if (col !== 8) return null;
        row -= 1;
    }
    return board;
}

// Was: Fuehrt `isPromotionMove` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function isPromotionMove(piece, to) {
    if (!piece) return false;
    const toRank = Math.floor(to / 8);
    if (piece === "P") return toRank === 7;
    if (piece === "p") return toRank === 0;
    return false;
}

// Was: Fuehrt `perft` aus und kapselt einen klar abgegrenzten Worker-Teilschritt.
// Warum: Haelt die Logik modular, nachvollziehbar und separat optimierbar.
// Kosten: Laufzeit ist kontextabhaengig und wird durch Eingabegroesse/Verzweigungen bestimmt.
function perft(fen, depth) {
    if (depth <= 0) return 1;
    const board = parseBoard(fen);
    const moves = collectMoves(fen);
    if (depth === 1) {
        if (!board) return moves.length;
        let count = 0;
        for (const [from, to] of moves) {
            const piece = board[from];
            if (isPromotionMove(piece, to)) {
                count += 4;
            } else {
                count += 1;
            }
        }
        return count;
    }

    let nodes = 0;
    for (const [from, to] of moves) {
        const piece = board ? board[from] : null;
        if (board && isPromotionMove(piece, to)) {
            for (const promo of ["q", "r", "b", "n"]) {
                const nextFen = apply_move(fen, from, to, promo);
                if (nextFen === fen) continue;
                nodes += perft(nextFen, depth - 1);
            }
        } else {
            const nextFen = apply_move(fen, from, to, "");
            if (nextFen === fen) continue;
            nodes += perft(nextFen, depth - 1);
        }
    }
    return nodes;
}

// Was: Registriert globales Error-Logging fuer den Worker.
// Warum: Macht Laufzeitfehler im Worker sofort sichtbar und erleichtert Diagnose im Browser-Log.
// Kosten: Nur im Fehlerfall aktiv; im Normalbetrieb praktisch kein Overhead.
self.addEventListener("error", (e) => {
    console.error(
        "Worker global error:",
        e.message,
        "in", e.filename,
        ":", e.lineno,
        ":", e.colno
    );
});

// Was: Zentraler Dispatch fuer alle eingehenden Worker-Aktionen (`moves`, `apply`, `perft`, `search`).
// Warum: Haelt den Kommunikationspfad zwischen UI und WASM-Engine an einer Stelle konsistent.
// Kosten: Konstante Dispatch-Kosten plus jeweilige Aktionskosten der aufgerufenen Engine-Routinen.
self.onmessage = async function (e) {
    const data = e.data || {};
    const action = data.action || "moves";

    // Jede Aktion wartet auf abgeschlossene WASM-Initialisierung.
    await wasmReady;

    if (action === "moves") {
        const moves = Array.from(get_valid_moves(data.fen || "", Number(data.field)));
        self.postMessage({ action: "moves", moves });
        return;
    }

    if (action === "apply") {
        const promotion = typeof data.promotion === "string" ? data.promotion : "";
        const fen = apply_move(data.fen || "", Number(data.from), Number(data.to), promotion);
        self.postMessage({ action: "apply", fen });
        return;
    }

    if (action === "perft") {
        const fen = data.fen || "";
        const depth = Number(data.depth);
        if (!fen || !Number.isFinite(depth) || depth < 0) {
            self.postMessage({ action: "perft", nodes: 0, depth, ms: 0 });
            return;
        }

        const t0 = performance.now();
        const nodes = perft(fen, depth);
        const ms = performance.now() - t0;
        self.postMessage({ action: "perft", nodes, depth, ms });
        return;
    }

    if (action === "search") {
        const fen = data.fen || "";
        const depth = Number(data.depth);
        const timeMs = Number(data.timeMs ?? data.time_ms ?? 0);
        const ttMb = Number(data.ttMb ?? data.tt_mb ?? 0);
        const gameId = Number.isFinite(data.gameId) ? data.gameId : 0;
        const bookEnabled = data.bookEnabled === true;
        const uciHistory = typeof data.uciHistory === "string" ? data.uciHistory : "";
        const debugRootEval = data.debugRootEval === true;

        if (!fen) {
            self.postMessage({ action: "search", error: "keine FEN vorhanden" });
            return;
        }

        // Jede Suche erhält eine eindeutige ID (Result + Progress).
        const searchId = ++searchSeq;

        try {
            if (typeof set_root_eval_debug === "function") {
                set_root_eval_debug(debugRootEval);
            }
        } catch (err) {
            console.warn("set_root_eval_debug failed:", err);
        }

        // Eröffnungsbuch hat Vorrang, wenn aktiv und legaler Zug gefunden wurde.
        const bookMove = await getBookMove(fen, uciHistory, gameId, bookEnabled);
        if (bookMove) {
            self.postMessage({
                action: "search",
                searchId,
                depth: 0,
                nodes: 0,
                time_ms: 0,
                nps: 0,
                score: 0,
                best: bookMove,
                pv: bookMove,
                book: true
            });
            return;
        }

        const safeDepth = Number.isFinite(depth) && depth > 0 ? depth : 0;
        const safeTimeMs = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : 0;
        const safeTtMb = Number.isFinite(ttMb) && ttMb > 0 ? ttMb : 0;

        const history = typeof data.history === "string" ? data.history : "";
        let result = null;
        activeSearchId = searchId;
        try {
            const raw = history && history.trim().length > 0
                ? search_with_history(fen, safeDepth, safeTimeMs, safeTtMb, history)
                : search(fen, safeDepth, safeTimeMs, safeTtMb);
            try {
                result = JSON.parse(raw);
            } catch (err) {
                console.error("moveWorker: search JSON parse failed:", err, raw);
                result = { error: "invalid result", raw };
            }
        } finally {
            activeSearchId = 0;
        }

        if (result && typeof result === "object") {
            self.postMessage({ action: "search", searchId, ...result });
        } else {
            self.postMessage({ action: "search", searchId, result });
        }
        return;
    }

    console.warn("Unknown action in moveWorker:", action, data);
};
