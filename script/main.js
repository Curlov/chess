import DeviceCheck from './core/DeviceCheck.js';
import MediaLoader from './core/MediaLoader.js';
import ChessBoard from './core/ChessBoard.js';
import GameController from './core/GameController.js';
import MoveList from './core/MoveList.js';
import { lanToField, fieldToLan, fenZuFigurenListe, getStartFen, getPuzzleFen, runPerft } from './utils/utilitys.js';


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

const useBackgroundImg = false;
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
        const mediaLoader = new MediaLoader(mediaUrls);
        mediaLoader.loadMedia().then(() => {
            const mediaMemory = mediaLoader.getLoadedMedia();

            // Worker zum Berechnen der erlaubten Züge
            const b1 = new ChessBoard("#b1", mediaMemory, device, {
                interactive: true, 
                ownColorOnly: false, 
                showLegalMoves: true, 
                showSelectedField: true,
                showMoves: true, 
                soundON: device === "desktop",
                sizeChessBoard: sizeChessBoard,
                isWhite: true,    
                useBackgroundImg: useBackgroundImg          
            });

            const mL1 = new MoveList();
            const c1 = new GameController(b1, mL1);

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
        });
    });
}

// stoppt scrollen auf dem handy!
document.addEventListener('touchmove', (e) => {
    e.preventDefault();
}, { passive: false });

