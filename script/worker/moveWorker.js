// worker/moveWorker.js
import init, { get_valid_moves, apply_move } from "../engine/pkg/chess_engine.js";

const wasmReady = init().catch((err) => {
    console.error("WASM init failed:", err);
    throw err;
});

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

    console.warn("Unknown action in moveWorker:", action, data);
};
