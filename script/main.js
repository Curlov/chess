import DeviceCheck from './core/DeviceCheck.js';
import MediaLoader from './core/MediaLoader.js';
import ChessBoard from './core/ChessBoard.js';
import GameController from './core/GameController.js';
import MoveList from './core/MoveList.js';
import { lanToField, fieldToLan, fenZuFigurenListe, getStartFen, getPuzzleFen, runPerft } from './utils/utilitys.js';
import { registerEngineBench } from './utils/engineBench.js';


// Hier wird geprüft, ob es sich um ein mobiles Device handelt oder um einen Desktop
const device = DeviceCheck.isMobile() ? "mobile" : "desktop";
let mediaUrls;

if (!device) {
    console.log(device);
    // Abbruch, wenn kein Desktop-Rechner mit Maus identifiziert wurde
    document.querySelector(".progress-text").innerText = "Abbruch, es konnte kein Device identifiziert werden!";
} else {
    console.log(device);
    // Media Link-Liste für große Dateien
    mediaUrls = [
        "./src/img/large/board.png", "./src/img/pieces/bb.svg", "./src/img/pieces/bk.svg", "./src/img/pieces/bn.svg",
        "./src/img/pieces/bp.svg", "./src/img/pieces/br.svg", "./src/img/pieces/bq.svg", "./src/img/pieces/wb.svg",
        "./src/img/pieces/wk.svg", "./src/img/pieces/wn.svg", "./src/img/pieces/wp.svg", "./src/img/pieces/wr.svg",
        "./src/img/pieces/wq.svg"
    ];
}

const useBackgroundImg = true;
let sizeChessBoard = 900;
const width  = window.innerWidth;

if (width <= sizeChessBoard) {
    sizeChessBoard = width;
}

if (useBackgroundImg === true) {
    sizeChessBoard = Math.floor(sizeChessBoard / 9) * 9;
}

// Hier geht es nur weiter, wenn mediaUrls entsprechende Links enthält - sonst sauberer Abbruch
if (mediaUrls != null) {
    window.addEventListener("load", () => {
        const timebar = document.querySelector(".timebar");
        const timebarFill = timebar?.querySelector(".timebar-fill");

            const engineTimer = (() => {
                let rafId = 0;
                let start = 0;
                let duration = 0;

            const tick = () => {
                const now = performance.now();
                const elapsed = now - start;
                const remaining = Math.max(0, duration - elapsed);
                const ratio = duration > 0 ? remaining / duration : 0;

                if (timebarFill) {
                    timebarFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
                }

                if (remaining > 0) {
                    rafId = requestAnimationFrame(tick);
                }
            };

                return {
                    start(durationMs) {
                        if (!timebar || !timebarFill) return;
                        if (rafId) cancelAnimationFrame(rafId);
                        timebarFill.style.transition = "";
                        duration = Math.max(0, Number(durationMs) || 0);
                        start = performance.now();
                        timebar.classList.remove("is-idle");
                        timebarFill.style.width = "100%";
                        rafId = requestAnimationFrame(tick);
                    },
                    stop(remainingMs, durationMs, hard = false) {
                        if (!timebar || !timebarFill) return;
                        if (rafId) cancelAnimationFrame(rafId);
                        rafId = 0;
                        if (hard) {
                            timebarFill.style.transition = "none";
                        }
                        if (Number.isFinite(remainingMs) && Number.isFinite(durationMs) && durationMs > 0) {
                            const ratio = Math.max(0, Math.min(1, remainingMs / durationMs));
                            timebarFill.style.width = `${ratio * 100}%`;
                        }
                        timebar.classList.add("is-idle");
                }
            };
        })();

        const mediaLoader = new MediaLoader(mediaUrls);
        mediaLoader.loadMedia().then(() => {
            const mediaMemory = mediaLoader.getLoadedMedia();

            // Worker zum Berechnen der erlaubten Züge
            const b1 = new ChessBoard("#b1", mediaMemory, device, {
                interactive: true, 
                ownColorOnly: true, 
                showLegalMoves: false, 
                showSelectedField: true,
                showMoves: true, 
                soundON: device === "desktop",
                sizeChessBoard: sizeChessBoard,
                isWhite: true,    
                useBackgroundImg: useBackgroundImg          
            });

            const mL1 = new MoveList();
            const ENGINE_TIME_MS = 12500;
            const ENGINE_MIN_TIME_MS = 1000;
            const ENGINE_TT_MB = 256;
            const BOOK_PAUSE_MS = 500;
            const c1 = new GameController(b1, mL1, {
                engineTimeMs: ENGINE_TIME_MS,
                engineMinTimeMs: ENGINE_MIN_TIME_MS,
                engineTtMb: ENGINE_TT_MB,
                bookPauseMs: BOOK_PAUSE_MS,
                autoOpponent: true,
                onEngineThinkStart: ({ durationMs }) => engineTimer.start(durationMs),
                onEngineThinkEnd: ({ remainingMs, durationMs }) => engineTimer.stop(remainingMs, durationMs),
                onGameEnd: () => engineTimer.stop(0, 1, true)
            });

            getPuzzleFen().then((x)=> c1.initPosition(x));

            // global machen:
            window.c1 = c1;
            window.getStartFen = getStartFen;
            window.getPuzzleFen = getPuzzleFen;
            window.perft = (depth = 3, fen = null) => runPerft(c1, depth, fen);
            window.search = (options = {}) => {
                console.log("[search] start", options);
                const t0 = performance.now();
                const p = c1.search(options);
                p.then((result) => {
                    const ms = performance.now() - t0;
                    window.lastSearchResult = result;
                    window.lastSearchMs = ms;
                    if (result && typeof result === "object") {
                        const summary = {
                            depth: result.depth ?? null,
                            score: result.score ?? null,
                            nodes: result.nodes ?? null,
                            nps: result.nps ?? null,
                            best: result.best ?? null,
                            pv: result.pv ?? null,
                            ms: result.time_ms ?? Math.round(ms)
                        };
                        console.log("[search] done", summary);
                        if (result.rep_avoid === true) {
                            console.log("[search] repetition avoided (non-losing alternative)", {
                                best: result.best ?? null,
                                score: result.score ?? null
                            });
                        }
                    } else {
                        console.log("[search] done", { ms, result });
                    }
                    console.log("[search] result", result);
                }).catch((err) => {
                    console.error("[search] error", err);
                });
                return p;
            };
            registerEngineBench(c1);
        });
    });
}

// stoppt scrollen auf dem handy!
document.addEventListener('touchmove', (e) => {
    e.preventDefault();
}, { passive: false });

