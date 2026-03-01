import DeviceCheck from './core/DeviceCheck.js';
import MediaLoader from './core/MediaLoader.js';
import ChessBoard from './core/ChessBoard.js';
import GameController from './core/GameController.js';
import MoveList from './core/MoveList.js';
import { lanToField, fieldToLan, fenZuFigurenListe, getStartFen, getPuzzleFen, runPerft } from './utils/utilitys.js';
import { registerEngineBench } from './utils/engineBench.js';

/**
 * Haupt-Einstieg (Variante 2) für UI + Board + GameController.
 * Entspricht funktional `main.js`, nutzt aber die zweite Index-Seite.
 */
// Hier wird geprüft, ob es sich um ein mobiles Device handelt oder um einen Desktop
const device = DeviceCheck.isMobile() ? "mobile" : "desktop";
let mediaUrls;

document.body?.classList.add(device === "mobile" ? "device-mobile" : "device-desktop");

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
        // UI-Referenzen für Engine-Livewerte + Startmenü.
        const timebar = document.querySelector(".timebar");
        const timebarFill = timebar?.querySelector(".timebar-fill");
        const engineStatus = document.querySelector(".engine-status");
        const engineStatusTime = engineStatus?.querySelector(".engine-status-time");
        const engineStatusTt = engineStatus?.querySelector(".engine-status-tt");
        const engineStatusDepth = engineStatus?.querySelector(".engine-status-depth");
        const engineStatusNodes = engineStatus?.querySelector(".engine-status-nodes");
        const gameState = document.querySelector(".game-state");
        const startOverlay = document.querySelector(".start-overlay");
        const colorWhiteButton = startOverlay?.querySelector("[data-color='w']");
        const colorBlackButton = startOverlay?.querySelector("[data-color='b']");
        const timeRange = startOverlay?.querySelector(".start-range");
        const timeText = startOverlay?.querySelector(".start-time-text");
        const legalMovesButton = startOverlay?.querySelector("[data-legal-moves]");
        const startButton = startOverlay?.querySelector(".start-button");
        const gameBackButton = document.querySelector(".game-back-button");
        const compactStatusMedia = window.matchMedia("(max-width: 560px)");

        // Time->TT-Mapping für den Startdialog.
        const ttFromTimeMs = (timeMs) => {
            const value = Number(timeMs) || 0;
            if (value >= 40000) return 1024;
            if (value >= 20000) return 512;
            if (value >= 12000) return 256;
            if (value >= 8000) return 128;
            if (value >= 4000) return 64;
            if (value >= 2000) return 16;
            return 8;
        };

        // Einheitliches Zeitformat "00.000".
        const formatTimeCompact = (timeMs) => {
            const value = Math.max(0, Math.floor(Number(timeMs) || 0));
            const raw = String(value).padStart(5, "0");
            return `${raw.slice(0, 2)}.${raw.slice(2)}`;
        };

        // Statuszeile für Check / Game-End.
        const setGameState = (text = "") => {
            if (!gameState) return;
            const value = String(text || "").trim();
            gameState.textContent = value || "\u00A0";
        };

        const setGameBackButtonVisible = (visible = false) => {
            if (!gameBackButton) return;
            gameBackButton.classList.toggle("show", visible);
            gameBackButton.setAttribute("aria-hidden", visible ? "false" : "true");
        };

        // Zeitbalken + Engine-Livewerte als gekapseltes Mini-Modul.
        const engineTimer = (() => {
            let rafId = 0;
            let start = 0;
            let duration = 0;
            let displayTimeMs = 0;
            let ttMb = 0;
            let lastStatusUpdate = 0;
            let stats = { depth: 0, nodes: 0 };
            let statusRemainingMs = 0;

            const STATUS_UPDATE_INTERVAL_MS = 250;

            const formatTimeMs = (ms) => {
                const value = Math.max(0, Math.floor(Number(ms) || 0));
                const raw = String(value).padStart(5, "0");
                return `${raw.slice(0, 2)}.${raw.slice(2)}`;
            };

            const formatTt = (mb) => {
                const value = Math.max(0, Math.floor(Number(mb) || 0));
                return String(value).padStart(4, "0");
            };

            const formatDepth = (depth) => {
                const value = Math.max(0, Math.floor(Number(depth) || 0));
                return String(value).padStart(2, "0");
            };

            const formatNodes = (nodes) => {
                const value = Math.max(0, Math.floor(Number(nodes) || 0));
                const raw = String(value).padStart(9, "0");
                return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
            };

            const setResultStats = (result) => {
                if (!result || typeof result !== "object") return;
                const data = result.result && typeof result.result === "object" ? result.result : result;
                const depth = Number(data.depth);
                if (Number.isFinite(depth) && depth >= stats.depth) {
                    stats.depth = depth;
                }
                const nodes = Number(
                    data.nodes_total ?? data.nodesTotal ?? data.nodes
                );
                if (Number.isFinite(nodes) && nodes >= stats.nodes) {
                    stats.nodes = nodes;
                }
            };

            // Rendert die vier Wertezeilen in gedrosseltem Intervall.
            const renderStatus = (remainingMs, force = false) => {
                if (!engineStatus) return;
                const now = performance.now();
                if (!force && now - lastStatusUpdate < STATUS_UPDATE_INTERVAL_MS) {
                    return;
                }
                lastStatusUpdate = now;
                const compact = device === "mobile" || compactStatusMedia?.matches === true;
                const timeText = `${compact ? "T" : "Time"}: ${formatTimeMs(displayTimeMs)}`;
                const ttText = `TT: ${formatTt(ttMb)}`;
                const depthText = `${compact ? "D" : "Depth"}: ${formatDepth(stats.depth)}`;
                const nodesText = `${compact ? "N" : "Nodes"}: ${formatNodes(stats.nodes)}`;

                if (engineStatusTime && engineStatusTt && engineStatusDepth && engineStatusNodes) {
                    engineStatusTime.textContent = timeText;
                    engineStatusTt.textContent = ttText;
                    engineStatusDepth.textContent = depthText;
                    engineStatusNodes.textContent = nodesText;
                    return;
                }

                engineStatus.textContent = `${timeText}  ${ttText}   ${depthText}   ${nodesText}`;
            };

            // rAF-Tick für den visuellen Fortschrittsbalken.
            const tick = () => {
                const now = performance.now();
                const elapsed = now - start;
                const remaining = Math.max(0, duration - elapsed);
                const ratio = duration > 0 ? remaining / duration : 0;
                statusRemainingMs = remaining;

                if (timebarFill) {
                    timebarFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
                }

                renderStatus(remaining);

                if (remaining > 0) {
                    rafId = requestAnimationFrame(tick);
                } else {
                    renderStatus(0, true);
                }
            };

            return {
                // Idle-/Vorbereitungszustand.
                configure(durationMs, options = {}) {
                    if (rafId) cancelAnimationFrame(rafId);
                    rafId = 0;

                    duration = Math.max(0, Number(durationMs) || 0);
                    displayTimeMs = duration;
                    statusRemainingMs = duration;
                    stats = { depth: 0, nodes: 0 };

                    if (Number.isFinite(Number(options.ttMb))) {
                        ttMb = Number(options.ttMb);
                    }
                    if (Number.isFinite(Number(options.displayTimeMs))) {
                        displayTimeMs = Math.max(0, Number(options.displayTimeMs));
                    }

                    if (timebar && timebarFill) {
                        timebar.classList.add("is-idle");
                        timebarFill.style.width = "100%";
                    }
                    renderStatus(statusRemainingMs, true);
                },
                // Start des Suchlaufs.
                start(durationMs, options = {}) {
                    if (rafId) cancelAnimationFrame(rafId);

                    duration = Math.max(0, Number(durationMs) || 0);
                    start = performance.now();
                    stats = { depth: 0, nodes: 0 };
                    statusRemainingMs = duration;

                    if (Number.isFinite(Number(options.ttMb))) {
                        ttMb = Number(options.ttMb);
                    }
                    if (Number.isFinite(Number(options.displayTimeMs))) {
                        displayTimeMs = Math.max(0, Number(options.displayTimeMs));
                    }

                    if (timebar && timebarFill) {
                        timebarFill.style.transition = "";
                        timebar.classList.remove("is-idle");
                        timebarFill.style.width = "100%";
                    }

                    renderStatus(duration, true);
                    rafId = requestAnimationFrame(tick);
                },
                // Progress-Updates während der Suche.
                progress(progress = {}, options = {}) {
                    if (Number.isFinite(Number(options.ttMb))) {
                        ttMb = Number(options.ttMb);
                    }
                    const depth = Number(progress.depth);
                    if (Number.isFinite(depth) && depth >= stats.depth) {
                        stats.depth = depth;
                    }
                    const nodes = Number(
                        progress.nodes_total ?? progress.nodesTotal ?? progress.nodes
                    );
                    if (Number.isFinite(nodes) && nodes >= stats.nodes) {
                        stats.nodes = nodes;
                    }
                    const elapsedMs = Number(progress.elapsedMs);
                    if (Number.isFinite(elapsedMs) && duration > 0) {
                        statusRemainingMs = Math.max(0, duration - elapsedMs);
                    }
                    renderStatus(statusRemainingMs);
                },
                // Ende des Suchlaufs (inkl. finale Werte).
                stop(remainingMs, durationMs, hard = false, options = {}) {
                    if (rafId) cancelAnimationFrame(rafId);
                    rafId = 0;

                    if (Number.isFinite(Number(options.ttMb))) {
                        ttMb = Number(options.ttMb);
                    }
                    setResultStats(options.result);

                    let statusRemaining = 0;
                    if (Number.isFinite(remainingMs) && Number.isFinite(durationMs) && durationMs > 0) {
                        statusRemaining = Math.max(0, Number(remainingMs));
                        if (timebar && timebarFill) {
                            const ratio = Math.max(0, Math.min(1, remainingMs / durationMs));
                            timebarFill.style.width = `${ratio * 100}%`;
                        }
                    }
                    statusRemainingMs = statusRemaining;
                    if (timebar && timebarFill) {
                        if (hard) {
                            timebarFill.style.transition = "none";
                        }
                        timebar.classList.add("is-idle");
                    }
                    renderStatus(statusRemainingMs, true);
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
            const START_TIME_MS = 8000;
            const ENGINE_MIN_TIME_MS = 1000;
            const BOOK_PAUSE_MS = 500;
            const START_TT_MB = ttFromTimeMs(START_TIME_MS);
            engineTimer.configure(START_TIME_MS, { ttMb: START_TT_MB, displayTimeMs: START_TIME_MS });

            // Zentraler Spielfluss-Controller.
            const c1 = new GameController(b1, mL1, {
                engineTimeMs: START_TIME_MS,
                engineMinTimeMs: ENGINE_MIN_TIME_MS,
                engineTtMb: START_TT_MB,
                bookPauseMs: BOOK_PAUSE_MS,
                autoOpponent: true,
                onEngineThinkStart: ({ durationMs, ttMb, displayTimeMs }) => engineTimer.start(durationMs, { ttMb, displayTimeMs }),
                onEngineThinkProgress: ({ depth, nodes, elapsedMs, ttMb }) => engineTimer.progress({ depth, nodes, elapsedMs }, { ttMb }),
                onEngineThinkEnd: ({ remainingMs, durationMs, ttMb, result }) => engineTimer.stop(remainingMs, durationMs, false, { ttMb, result }),
                onGameState: (state) => setGameState(state?.message || ""),
                onGameEnd: (outcome) => {
                    engineTimer.stop(0, 1, true, {});
                    setGameState(outcome?.message || "Game over.");
                    setGameBackButtonVisible(true);
                    if (startButton) {
                        startButton.disabled = false;
                    }
                }
            });

            const setup = {
                playerColor: "w",
                showLegalMoves: false,
                timeMs: START_TIME_MS
            };
            setGameState("");
            setGameBackButtonVisible(false);

            // Schreibt den aktuellen Setup-State in die Menüsteuerung.
            const renderSetup = () => {
                const ttMb = ttFromTimeMs(setup.timeMs);
                if (timeRange) {
                    timeRange.value = String(setup.timeMs);
                }
                if (timeText) {
                    timeText.textContent = formatTimeCompact(setup.timeMs);
                }
                if (colorWhiteButton && colorBlackButton) {
                    colorWhiteButton.classList.toggle("active", setup.playerColor === "w");
                    colorBlackButton.classList.toggle("active", setup.playerColor === "b");
                }
                if (legalMovesButton) {
                    legalMovesButton.classList.toggle("active", setup.showLegalMoves);
                    legalMovesButton.textContent = `Show legal moves: ${setup.showLegalMoves ? "ON" : "OFF"}`;
                }
                engineTimer.configure(setup.timeMs, { ttMb, displayTimeMs: setup.timeMs });
            };

            renderSetup();

            colorWhiteButton?.addEventListener("click", () => {
                setup.playerColor = "w";
                renderSetup();
            });

            colorBlackButton?.addEventListener("click", () => {
                setup.playerColor = "b";
                renderSetup();
            });

            timeRange?.addEventListener("input", () => {
                const value = Number(timeRange.value);
                setup.timeMs = Number.isFinite(value) ? Math.max(1000, Math.min(60000, Math.floor(value))) : START_TIME_MS;
                renderSetup();
            });

            legalMovesButton?.addEventListener("click", () => {
                setup.showLegalMoves = !setup.showLegalMoves;
                renderSetup();
            });

            gameBackButton?.addEventListener("click", () => {
                setGameState("");
                setGameBackButtonVisible(false);
                if (startButton) {
                    startButton.disabled = false;
                }
                renderSetup();
                if (startOverlay) {
                    startOverlay.classList.add("show");
                    startOverlay.setAttribute("aria-hidden", "false");
                }
            });

            startButton?.addEventListener("click", async () => {
                if (startButton.disabled) return;
                startButton.disabled = true;

                const ttMb = ttFromTimeMs(setup.timeMs);
                const isBlack = setup.playerColor === "b";

                b1.showLegalMoves = setup.showLegalMoves;
                c1.engineTimeMs = setup.timeMs;
                c1.engineTtMb = ttMb;

                c1.initPosition(getStartFen());
                b1.myColor = setup.playerColor;
                setGameState("");
                setGameBackButtonVisible(false);

                if (b1.isFlipped !== isBlack) {
                    b1.flipBoard();
                }

                engineTimer.configure(setup.timeMs, { ttMb, displayTimeMs: setup.timeMs });

                if (startOverlay) {
                    startOverlay.classList.remove("show");
                    startOverlay.setAttribute("aria-hidden", "true");
                }

                // Bei Spielerseite Schwarz macht Weiß (Engine) den ersten Zug.
                await c1.syncAutoOpponentForPlayer(setup.playerColor);
            });


            
            // Debug-Hooks für Browser-Konsole.
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
                        const nodesValue = result.nodes_total ?? result.nodesTotal ?? result.nodes ?? null;
                        const nodesCompleted = result.nodes_completed ?? result.nodesCompleted ?? result.nodes ?? null;
                        const depthRaw = Number(result.depth);
                        const hasDeeperWork = Number(nodesValue) > Number(nodesCompleted);
                        const depthDisplay = Number.isFinite(depthRaw)
                            ? depthRaw + (hasDeeperWork ? 1 : 0)
                            : (result.depth ?? null);
                        const summary = {
                            depth: depthDisplay,
                            score: result.score ?? null,
                            nodes: nodesValue,
                            nps: result.nps ?? null,
                            best: result.best ?? null,
                            pv: result.pv ?? null,
                            ms: result.time_ms ?? Math.round(ms)
                        };
                        console.log("[search] done", summary);
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
    const target = e.target;
    if (target instanceof Element) {
        // UI-Controls im Overlay (z.B. Range-Slider) dürfen Touch-Move normal verarbeiten.
        if (target.closest('.start-overlay, .promotion-overlay')) {
            return;
        }
    }
    e.preventDefault();
}, { passive: false });

