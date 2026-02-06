// worker/moveWorker.js
import init, { get_valid_moves, apply_move } from "../engine/pkg/chess_engine.js";

const wasmReady = init().catch((err) => {
    console.error("WASM init failed:", err);
    throw err;
});

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

    console.warn("Unknown action in moveWorker:", action, data);
};
