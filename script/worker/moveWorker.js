// worker/moveWorker.js
import init, { get_valid_moves, apply_move, search, search_with_history, set_root_eval_debug } from "../engine/pkg/chess_engine.js";

const wasmReady = init().catch((err) => {
    console.error("WASM init failed:", err);
    throw err;
});

const openingBookUrl = new URL("../engine/openingBook/opening_book_1000.json", import.meta.url);
const openingBookReady = (async () => {
    try {
        const res = await fetch(openingBookUrl);
        if (!res.ok) {
            console.warn("Opening book load failed:", res.status, res.statusText);
            return null;
        }
        const data = await res.json();
        if (!data || typeof data !== "object") {
            console.warn("Opening book invalid format");
            return null;
        }
        return data;
    } catch (err) {
        console.warn("Opening book load error:", err);
        return null;
    }
})();

const bookState = {
    active: true,
    gameId: null,
    lastHistory: ""
};

let searchSeq = 0;
let activeSearchId = 0;

function toSafeInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

globalThis.__engine_progress = (depth, nodesCompleted, nodesTotal, elapsedMs) => {
    if (!activeSearchId) return;
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

function normalizeHistory(history) {
    return String(history || "").trim().replace(/\s+/g, " ");
}

function shouldResetBook(gameId, history) {
    if (bookState.gameId !== gameId) return true;
    if (history.length < bookState.lastHistory.length) return true;
    if (bookState.lastHistory && !history.startsWith(bookState.lastHistory)) return true;
    return false;
}

function lanToField(lan) {
    if (!lan || lan.length !== 2) return null;
    const file = lan.charCodeAt(0) - 97; // 'a'
    const rank = lan.charCodeAt(1) - 49; // '1'
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return rank * 8 + file;
}

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

function pickBookMove(moves) {
    let bestMove = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const uci in moves) {
        const raw = moves[uci];
        const score = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(score)) continue;
        if (score > bestScore) {
            bestScore = score;
            bestMove = uci;
        }
    }
    return bestMove;
}

function pickLegalBookMove(fen, moves) {
    const entries = [];
    for (const uci in moves) {
        const raw = moves[uci];
        const score = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(score)) continue;
        entries.push({ uci, score });
    }
    entries.sort((a, b) => b.score - a.score);

    const cache = new Map();
    for (const entry of entries) {
        const parsed = parseUci(entry.uci);
        if (!parsed) continue;
        let targets = cache.get(parsed.from);
        if (!targets) {
            targets = new Set(Array.from(get_valid_moves(fen, parsed.from)));
            cache.set(parsed.from, targets);
        }
        if (targets.has(parsed.to)) {
            return entry.uci;
        }
    }
    return "";
}

async function getBookMove(fen, historyUci, gameId, bookEnabled) {
    if (!bookEnabled) return null;

    const history = normalizeHistory(historyUci);
    if (shouldResetBook(gameId, history)) {
        bookState.active = true;
        bookState.gameId = gameId;
    }
    bookState.lastHistory = history;

    if (!bookState.active) return null;

    const book = await openingBookReady;
    if (!book) {
        bookState.active = false;
        return null;
    }
    const entry = book[history];
    if (!entry || !entry.moves) {
        bookState.active = false;
        return null;
    }
    const bestMove = pickLegalBookMove(fen, entry.moves);
    if (!bestMove) {
        bookState.active = false;
        return null;
    }
    return bestMove;
}

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

function isPromotionMove(piece, to) {
    if (!piece) return false;
    const toRank = Math.floor(to / 8);
    if (piece === "P") return toRank === 7;
    if (piece === "p") return toRank === 0;
    return false;
}

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

self.addEventListener("error", (e) => {
    console.error(
        "Worker global error:",
        e.message,
        "in", e.filename,
        ":", e.lineno,
        ":", e.colno
    );
});

self.onmessage = async function (e) {
    const data = e.data || {};
    const action = data.action || "moves";

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

        const searchId = ++searchSeq;

        try {
            if (typeof set_root_eval_debug === "function") {
                set_root_eval_debug(debugRootEval);
            }
        } catch (err) {
            console.warn("set_root_eval_debug failed:", err);
        }

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
