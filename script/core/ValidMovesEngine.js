// script/ValidMovesEngine.js

export default class ValidMovesEngine {
    constructor() {
        const workerUrl = new URL("../worker/moveWorker.js", import.meta.url);
        console.log("ValidMovesEngine: Initialisiere Worker mit URL:", workerUrl.href);

        this.worker  = new Worker(workerUrl, { type: "module" });
        this.pending = null;

        this.worker.onmessage = (e) => {
            //console.log("ValidMovesEngine: Worker onmessage (raw):", e.data);

            if (!this.pending) {
                console.warn("ValidMovesEngine: Message ohne pending:", e.data);
                return;
            }

            const { resolve, type } = this.pending;
            this.pending = null;

            const payload = e.data || {};

            if (type === "moves") {
                resolve(payload.moves || []);
            } else if (type === "apply") {
                resolve(payload.fen);
            } else {
                console.warn("ValidMovesEngine: unbekannter pending-Typ:", type, payload);
                resolve(payload);
            }
        };

        this.worker.onerror = (err) => {
            console.error(
                "ValidMovesEngine: Worker onerror",
                "\n  message:", err.message,
                "\n  filename:", err.filename,
                "\n  lineno:", err.lineno,
                "\n  colno:", err.colno,
                "\n  raw:", err
            );

            if (this.pending) {
                const { reject } = this.pending;
                this.pending = null;
                reject(err);
            }
        };
    }

    getValidMoves(fen, field) {
        console.log("ValidMovesEngine.getValidMoves:", { fen, field });

        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        if (this.pending) {
            console.warn("ValidMovesEngine: es gibt noch eine offene Anfrage, verwerfe sie.");
            this.pending = null;
        }

        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, type: "moves" };

            try {
                this.worker.postMessage({
                    action: "moves",
                    fen,
                    field
                });
                //console.log("ValidMovesEngine: postMessage (moves) abgesetzt");
            } catch (err) {
                console.error("ValidMovesEngine: Fehler bei postMessage (moves):", err);
                this.pending = null;
                reject(err);
            }
        });
    }

    applyMove(fen, from, to) {
        //console.log("ValidMovesEngine.applyMove:", { fen, from, to });

        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        if (this.pending) {
            console.warn("ValidMovesEngine: es gibt noch eine offene Anfrage, verwerfe sie.");
            this.pending = null;
        }

        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, type: "apply" };

            try {
                this.worker.postMessage({
                    action: "apply",
                    fen,
                    from,
                    to
                });
                //console.log("ValidMovesEngine: postMessage (apply) abgesetzt");
            } catch (err) {
                console.error("ValidMovesEngine: Fehler bei postMessage (apply):", err);
                this.pending = null;
                reject(err);
            }
        });
    }

    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }
}
