import { 
    lanToField, 
    fieldToLan, 
    fenZuFigurenListe, 
    getStartFen, 
    getPuzzleFen 
} from '../utils/utilitys.js';

export default class ChessBoard {
    constructor(containerID, loadedMedia, device, options = {}) {
        // Optionen mit Defaults – so kannst du das Brett flexibel konfigurieren
        const {
            interactive = true,      // Brett reagiert auf Maus (Drag) oder ist passiv
            ownColorOnly = true,     // darfst du nur deine eigene Farbe ziehen?
            showLegalMoves = true,   // erlaubte Züge optisch markieren
            showSelectedField = true,// Zeigt bei Nutzung der Maus keine Feldaktivierung an
            showMoves = true,        // Animations-/Zug-Highlighting
            soundON = false,         // Soundeffekte an/aus
            sizeChessBoard = 600,    // Kantenlänge eines Feldes in px
            isWhite = true,          // Startansicht: aus Weiß- oder Schwarz-Sicht
            useBackgroundImg = true  // Hintergrundbild für Schachcontainer/board ist standardmäßig gesetzt   
        } = options;
        
        // DOM-Elemente
        this.container      = document.querySelector(containerID);    // äußerer Container (boardContainer)
        this.board          = this.container.querySelector(".board"); // inneres 8x8-Grid
        this.sizeChessBoard = sizeChessBoard;
        this.sizeField      = useBackgroundImg === true ? Math.round((this.sizeChessBoard / 9)):Math.round((this.sizeChessBoard / 8));

        // Bindings für Event-Handler (damit "this" stimmt, wenn als Callback verwendet)
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp   = this.onMouseUp.bind(this);

        // Drag-State
        this.currentElement  = null;  // aktuell gezogene Figur
        this.dragOffsetX     = 0;     // Mausversatz zur Figurenmitte (X)
        this.dragOffsetY     = 0;     // Mausversatz zur Figurenmitte (Y)
        this.highlightFadeMs = 100;

        // Konfiguration / Zustände
        this.interactive        = interactive;
        this.ownColorOnly       = ownColorOnly;
        this.showLegalMoves     = showLegalMoves;
        this.showSelectedField  = showSelectedField;
        this.showMoves          = showMoves;
        this.isWhite            = isWhite; 
        this.device             = device;
        this.useBackgroundImg   = useBackgroundImg;
        this.onUserMove         = null;
        this.onMoveStart        = null;
        this.soundON            = soundON; 
        this.sounds             = {};
        this.soundBase          = 'src/sounds/';
        this.soundTypes         = ['move', 'capture', 'error'];

        for (const type of this.soundTypes) {
            const audio = new Audio(this.soundBase + type + '.mp3');
            audio.preload = 'auto';
            audio.volume = 1; // volle Lautstärke
            this.sounds[type] = audio;
        }

        // Touch-Selection-State (für 2-Tap-Steuerung)
        this.selectedPiece = null;   // per Touch ausgewählte Figur
        this.selectedField = null;   // logisches Feld 0..63

        // Mapping von FEN-Figurentyp → Key im geladenen Media-Objekt
        this.fenTypeToImgType = {
            "p": "bp", "r": "br", "n": "bn", "b": "bb", "q": "bq", "k": "bk",
            "P": "wp", "R": "wr", "N": "wn", "B": "wb", "Q": "wq", "K": "wk"
        };

        // Assets (Bilder, Sounds, Board-Sprite usw.)
        this.loadedMedia = loadedMedia;
        this.promotionOverlay = null;
        this.promotionDialog  = null;
        this.promotionPending = false;
        this.promotionPromise = null;
        this.enPassantField   = null;

        // FEN-/Spielzustand
        this.figurenListe = [];       // Liste mit Figuren und Positionen
        this.sideToMove   = "w";
        this.validMoves   = [];       // vom Worker berechnete legalen Züge für die aktuell angefasste Figur
        this.myColor      = null;     // "w" oder "b" – Spielerfarbe (wird in createPieces gesetzt)
        this.isFlipped    = false;    // Startansicht: aus Weiß- oder Schwarz-Sicht


        // CSS-Variablen für Größen setzen und ggf. existierende Figuren neu positionieren
        this.setBoardSize();
        this.initPromotionOverlay();
        // Grid-Struktur (64 Squares) + Background setzen + Drag aktivieren
        this.createBoard();
        // Drag für Maus ist schon in createBoard() aktiviert
        // -> jetzt Touch-2-Tap ergänzen
        this.enableTouchTap();

        // Interaktivität auch visuell kenntlich machen
        if (!this.interactive) {
            this.board.classList.add("nonInteractive");
        } else {
            this.board.classList.remove("nonInteractive");
        }
    }

    // Berechnet und setzt die Größen für Brett + Ränder + Figuren via CSS-Variablen
    setBoardSize() {
        const sizeRims       = Math.round(this.useBackgroundImg === true ? (this.sizeChessBoard / 9): 0);    // Rand
        const sizeAllFields  = Math.round(this.sizeField * 8);      // 8 Felder nebeneinander
        const sizePieces     = Math.round(this.sizeField * 0.8);    // Figuren etwas kleiner als Feld * 0.8

        const root = this.container;

        // CSS-Custom-Properties am Container setzen
        root.style.setProperty('--field',      `${this.sizeField}px`); //.this
        root.style.setProperty('--allFields',  `${sizeAllFields}px`);
        root.style.setProperty('--rims',       `${sizeRims}px`);
        root.style.setProperty('--chessBoard', `${this.sizeChessBoard}px`);
        root.style.setProperty('--pieces',     `${sizePieces}px`);

        // Falls schon Figuren auf dem Brett stehen: alle auf neue Größen anpassen
        const pieces = this.board.querySelectorAll(".piece");
        pieces.forEach((piece) => {
            const field = parseInt(piece.dataset.position, 10); // logisches Feld 0..63
            const { x, y } = this.getSquareCenter(field);       // Pixelposition (berücksichtigt Flip)
            piece.style.left = x + "px";
            piece.style.top  = y + "px";
        });
    }

    // Erstellt das 8x8-Grid und setzt den Hintergrund (Board-Sprite)
    createBoard() {
        // Sicherstellen, dass das Grid leer ist
        this.board.innerHTML = "";
        const content = this.container; 

        // Kontextmenü (Rechtsklick) auf dem Brett deaktivieren
        this.board.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

        // Hintergrundbild für das Brett setzen (Sprite mit Koordinaten)
        const boardImage = this.loadedMedia['board'];
        if (boardImage) {
            content.style.backgroundImage    = `url(${boardImage.src})`;
            content.style.backgroundSize     = "cover";
            content.style.backgroundPosition = "center center";
            content.style.backgroundRepeat   = "no-repeat";
        }

        // 8x8-Squares erzeugen
        // row: 8 → 1 (oben nach unten), col: 1 → 8 (links nach rechts)
        for (let row = 8; row >= 1; row--) {
            for (let col = 1; col <= 8; col++) {
                const square = document.createElement("div");
                square.classList.add("square");

                // Algebraische Notation aus Sicht von Weiß (a1..h8)
                const columnLetter = String.fromCharCode(96 + col); // 1→a, 2→b, ...
                square.dataset.notation = `${columnLetter}${row}`;

                // logisches Feld 0..63 (Bitboard-Index, Weiß-Sicht)
                square.dataset.field    = ((row - 1) * 8 + (col - 1)).toString();

                if (!this.useBackgroundImg) {
                    // Farbinfo (a1 soll dunkel sein)
                    const isDark = (row + col) % 2 === 0; 
                    const color  = isDark ? "dark" : "light";

                    //square.dataset.color = color;
                    square.classList.add(`square-${color}`);
                }

                this.board.appendChild(square);
            }
        }

        // Drag-Logik aktivieren
        this.enableDrag();
        // Notation optional an Flip-Sicht anpassen (z.B. damit sie mit dem Brett-Sprite übereinstimmt)
        this.updateNotations(); 
        if (!this.isWhite) this.flipBoard();
    }

    initPromotionOverlay() {
        const overlay = this.container.querySelector(".promotion-overlay");
        if (!overlay) {
            console.warn("Promotion-Overlay nicht gefunden");
            return;
        }

        let dialog = overlay.querySelector(".promotion-dialog");
        if (!dialog) {
            dialog = document.createElement("div");
            dialog.classList.add("promotion-dialog");
            overlay.appendChild(dialog);
        }

        this.promotionOverlay = overlay;
        this.promotionDialog = dialog;
    }

    requestPromotion(color) {
        const defaultPiece = color === "w" ? "Q" : "q";

        if (!this.promotionOverlay || !this.promotionDialog) {
            return Promise.resolve(defaultPiece);
        }

        if (this.promotionPending && this.promotionPromise) {
            return this.promotionPromise;
        }

        const pieces = color === "w" ? ["Q", "R", "B", "N"] : ["q", "r", "b", "n"];
        this.promotionDialog.innerHTML = "";

        pieces.forEach((piece) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.classList.add("promotion-choice");
            btn.dataset.piece = piece;

            const imgKey = this.fenTypeToImgType[piece];
            const img = this.loadedMedia[imgKey];

            if (img) {
                const icon = document.createElement("img");
                icon.src = img.src;
                icon.alt = piece;
                btn.appendChild(icon);
            } else {
                btn.textContent = piece.toUpperCase();
            }

            this.promotionDialog.appendChild(btn);
        });

        this.promotionOverlay.classList.add("show");
        this.promotionOverlay.setAttribute("aria-hidden", "false");
        this.promotionPending = true;

        this.promotionPromise = new Promise((resolve) => {
            const handleClick = (event) => {
                const btn = event.target.closest(".promotion-choice");
                if (!btn) return;

                const choice = btn.dataset.piece || defaultPiece;
                this.promotionOverlay.classList.remove("show");
                this.promotionOverlay.setAttribute("aria-hidden", "true");
                this.promotionOverlay.removeEventListener("click", handleClick);

                this.promotionPending = false;
                this.promotionPromise = null;
                resolve(choice);
            };

            this.promotionOverlay.addEventListener("click", handleClick);
        });

        return this.promotionPromise;
    }

    promotePiece(fromField, toField, newType) {
        let piece = this.getPieceAt(toField);
        if (!piece) {
            piece = this.getPieceAt(fromField);
        }
        if (!piece) {
            console.warn("promotePiece: keine Figur gefunden", { fromField, toField });
            return;
        }

        const imgKey = this.fenTypeToImgType[newType];
        const img = this.loadedMedia[imgKey];

        piece.dataset.type = newType;

        if (img) {
            piece.src = img.src;
        }

        if (newType.toLowerCase() === "p") {
            piece.dataset.scale = "0.8";
            piece.style.setProperty('--piece-scale', '0.8');
        } else {
            piece.dataset.scale = "1.0";
            piece.style.setProperty('--piece-scale', '1.0');
        }
    }

    // Erzeugt alle Figuren anhand der aktuellen FEN-Daten in this.fen
    createPieces() {
        // Spielerfarbe ist "wer ist am Zug" aus der FEN
        this.myColor = this.sideToMove;

        const pieces = this.figurenListe;

        pieces.forEach(({ field, type }) => {
            const template = this.loadedMedia[this.fenTypeToImgType[type]];
            if (!template) return;

            // Jede Figur bekommt eine eigene IMG-Kopie
            const piece = template.cloneNode(true);
            piece.classList.add("piece");
            piece.dataset.type = type;
            piece.draggable = false; // Browser-Default-Drag für Bilder deaktivieren

            // Bauern leicht kleiner skalieren
            if (type.toLowerCase() === "p") {
                piece.dataset.scale = "0.8";
                piece.style.setProperty('--piece-scale', '0.8');
            } else {
                piece.dataset.scale = "1.0";
                piece.style.setProperty('--piece-scale', '1.0');
            }

            // Position auf dem Brett ermitteln (Pixel)
            const { x, y } = this.getSquareCenter(field);
            piece.style.left = x + "px";
            piece.style.top  = y + "px";

            // logisches Feld im Dataset speichern (0..63)
            piece.dataset.position = String(field);

            this.board.appendChild(piece);
        });
    }

    // Entfernt alle Figuren vom Brett + optional Highlights
    clearAllPieces() {
        const pieces = this.board.querySelectorAll(".piece");
        pieces.forEach(p => p.remove());

        // falls vorhanden: Highlights sofort löschen
        if (typeof this.clearHighlights === "function") {
            this.clearHighlights(true);
        }
    }

    // Setzt eine einzelne Figur auf ein Feld (mit evtl. Schlagen)
    placePiece(field, type) {
        const f = Number(field);

        // Wenn auf diesem Feld schon eine Figur steht → entfernen (Schlagen)
        const existing = this.getPieceAt(f);
        if (existing) {
           this.removePiece(f);
        }

        // Bild aus den geladenen Assets holen
        const imgKey = this.fenTypeToImgType[type];
        const img    = this.loadedMedia[imgKey];
        if (!img) {
            console.warn("Kein Bild für Figurentyp", type);
            return;
        }

        const piece = document.createElement("img");
        piece.src = img.src;
        piece.classList.add("piece");
        piece.dataset.type = type;
        piece.draggable = false;

        // Skalierung im Dataset notieren
        if (type.toLowerCase() === "p") {
            piece.dataset.scale = "0.8";
        } else {
            piece.dataset.scale = "1.0";
        }
        // Transform-Basis (Zentrierung + Scale) setzen
        piece.style.transform = `translate(-50%, -50%) scale(${piece.dataset.scale})`;

        // Position bestimmen und anwenden
        const { x, y } = this.getSquareCenter(f);
        piece.style.left = x + "px";
        piece.style.top  = y + "px";
        piece.dataset.position = String(f);

        this.board.appendChild(piece);

        return piece;
    }

    getPieceAt(field) {
        return this.board.querySelector(`.piece[data-position="${field}"]`);

    }

    // Hier wird mit Effekt gelöscht - Achtung, hier wird das Element selbst übergeben!
    removePieceEffect(piece) {
        if (!piece) {
            console.warn("removePieceEffect: kein piece übergeben");
            return;
        }

        piece.classList.add('removing');
        piece.addEventListener('transitionend', () => {
            piece.remove();
        }, { once: true });
    }

    // Entfernt eine Figur von einem bestimmten Feld
    removePieceInstant(field) {
        const f = Number(field);
        const piece = this.getPieceAt(f);
        if (!piece) {
            console.warn("Keine Figur auf Feld", f);
            return;
        }
        piece.remove();
    }

    // High-Level API: Figur von Feld A nach Feld B bewegen (mit Animation)
    move(fromField, toField, highlightMove = true, onDone, options = {}) {
        const { skipTurnChange = false } = options;
        const piece = this.getPieceAt(fromField); 
        if (!piece) {
            console.warn("Keine Figur auf Feld:", fromField);
            return;
        }

        this.animateMovePiece(piece, fromField, toField, highlightMove, onDone);
        if (!skipTurnChange) {
            this.changesideToMove();
        }
    }

    // Animiert eine Figur von "from" nach "to"
    animateMovePiece(piece, fromField, toField, highlightMove = true, onDone) {
        const from = Number(fromField);
        const to   = Number(toField);

        // Optional: Startfeld / Zug visualisieren
        if (this.showMoves) {
            this.clearHighlights();
            if (highlightMove) {
                this.highlight(from, "f");
            }
            
        }

        // Start- und Endposition in Pixeln bestimmen (inkl. Flip)
        const { x: sx, y: sy } = this.getSquareCenter(from);
        const { x: ex, y: ey } = this.getSquareCenter(to);

        // Distanz berechnen (für dynamische Dauer)
        const fFile = from % 8;
        const fRank = Math.floor(from / 8);
        const tFile = to % 8;
        const tRank = Math.floor(to / 8);
        const dx = Math.abs(tFile - fFile);
        const dy = Math.abs(tRank - fRank);
        const dist = Math.max(dx, dy); // Königsmeter

        const minMoveDuration = 50;   // min. Animationsdauer (1 Feld)
        const maxMoveDuration = 300;  // max. Animationsdauer (lange Diagonale)
        const maxDist         = 7;    // maximale Distanz auf 8x8

        const moveDuration = minMoveDuration +
            (maxMoveDuration - minMoveDuration) * (dist / maxDist);

        const liftPause = 100; // kleine "Lift"-Verzögerung vor der Bewegung

        // Alle anderen Figuren temporär deaktivieren (kein Anklicken während Animation)
        const allPieces = this.board.querySelectorAll(".piece");
        allPieces.forEach(p => {
            if (p !== piece) p.style.pointerEvents = "none";
        });

        // Sicherstellen, dass keine Drag-Klassen stören
        piece.classList.remove("drag");
        piece.classList.add("moving"); 

        // Start der Bewegung nach kurzer Pause
        const startMove = () => {
            let moveStart = null;

            const move = (ts) => {
                if (!moveStart) moveStart = ts;

                let t = (ts - moveStart) / moveDuration;
                if (t > 1) t = 1;

                // Lerp zwischen Start- und Endpunkt
                const x = sx + (ex - sx) * t;
                const y = sy + (ey - sy) * t;

                piece.style.left = x + "px";
                piece.style.top  = y + "px";

                if (t < 1) {
                    requestAnimationFrame(move);
                } else {
                    finalize();
                }
            };

            requestAnimationFrame(move);
        };

        // Abschluss der Bewegung: Figuren schlagen, Endposition fixieren, Sound etc.
        const finalize = () => {
            // Falls auf dem Zielfeld eine andere Figur steht → schlagen
            // const destPiece = this.getPieceAt(to);
            // if (destPiece && destPiece !== piece) {
            //     this.removePiece(to);
            // }

            // Endposition sauber setzen (zentriert auf Ziel-Feld)
            const { x: fx, y: fy } = this.getSquareCenter(to);
            piece.style.left = fx + "px";
            piece.style.top  = fy + "px";

            piece.style.zIndex = "";
            piece.classList.remove("moving");
            piece.dataset.position = String(to); // logisches Zielfeld speichern

            // Andere Figuren wieder klickbar machen
            allPieces.forEach(p => p.style.pointerEvents = "");

           	// Optional: Zielfeld hervorheben
            if (this.showMoves && highlightMove) {
                this.highlight(to, "f");
            }

            // Callback nach Abschluss
            if (onDone) onDone();
        };

        // kurze "Lift"-Pause vor der Animation
        setTimeout(startMove, liftPause);
    }

    // Rechnet logisches Feld (0..63) -> Pixelzentrum des Feldes
    getSquareCenter(field) {
        const f = Number(field);
        const file = f % 8;                  // 0..7 (0 = a)
        const rankFromBottom = Math.floor(f / 8); // 0..7 (0 = 1. Reihe unten)

        let col        = file;               // Spalte im Grid
        let rowFromTop = 7 - rankFromBottom; // 0 = oberste Reihe im DOM

        // Wenn gedreht: Spalten und Reihen spiegeln
        if (this.isFlipped) {
            col        = 7 - col;
            rowFromTop = 7 - rowFromTop;
        }

        // Mittelpunkt des Feldes in Pixeln
        const x = (col + 0.5) * this.sizeField;
        const y = (rowFromTop + 0.5) * this.sizeField;
        return { x, y };
    }

    // Rechnet Pixelkoordinaten (innerhalb des Boards) -> logisches Feld 0..63
    getFieldFromCoords(x, y) {
        // Spalte/Zeile aus Pixeln bestimmen
        let col        = Math.floor(x / this.sizeField);
        let rowFromTop = Math.floor(y / this.sizeField);

        // Bei Flip inverse Abbildung – wir korrigieren wieder in die logische Sicht
        if (this.isFlipped) {
            col        = 7 - col;
            rowFromTop = 7 - rowFromTop;
        }

        const rankFromBottom = 7 - rowFromTop;
        return rankFromBottom * 8 + col;
    }

    // Sucht eine Figur anhand ihres logischen Feldes (dataset.position)
    getPieceAt(field) {
        const f = String(field);
        const pieces = this.board.querySelectorAll(".piece");
        for (const p of pieces) {
            if (p.dataset.position === f) return p;
        }
        return null;
    }

    // Entfernt alle Highlights vom Brett (mit optionalem Fade-Out)
    clearHighlights(immediate = false) {
        const squares = Array.from(
            this.board.querySelectorAll(".square.f-color, .square.c-color, .square.s-color, .square.show")
        );

        if (squares.length === 0) return;

        // Sichtbarkeit der Overlays wegnehmen (CSS-Transition)
        squares.forEach(sq => sq.classList.remove("show"));

        if (immediate) {
            // Direkt alles weg (ohne Animation)
            squares.forEach(sq => sq.classList.remove("f-color", "c-color", "s-color"));
        } else {
            // Nach kurzer Zeit Farbklassen entfernen (passt zur CSS-Transition)
            setTimeout(() => {
                squares.forEach(sq => sq.classList.remove("f-color", "c-color", "s-color"));
            }, this.highlightFadeMs);
        }
    }


    // Markiert ein oder mehrere Felder als Highlights (z.B. legale Züge oder letzter Zug)
    highlight(fields, type = "f") {
        const colorMap = {
            f: "f-color",
            c: "c-color",
            s: "s-color"
        };

        const colorClass = colorMap[type]; 

        if (fields == null) return;
        if (!Array.isArray(fields)) fields = [fields];

        fields.forEach(f => {
            // f kann String oder Zahl sein → immer in Number umwandeln
            const logicalField = Number(f);
            
            // Anzeige-Index: bei Flip werden die Felder gespiegelt,
            // damit das Highlight optisch zum gedrehten Brett passt.
            const displayField = this.isFlipped ? 63 - logicalField : logicalField;
            const sq = this.board.querySelector(`.square[data-field="${displayField}"]`);
            if (!sq) return;

            sq.classList.add(colorClass);
            sq.classList.add("show");
        });
    }

    // Aktiviert Drag & Drop auf Figuren
    enableDrag() {
        if (!this.interactive) return;

        this.board.addEventListener("mousedown", (event) => {
            const piece = event.target.closest(".piece");
            if (!piece) return;

            event.preventDefault();

            const field  = Number(piece.dataset.position); // logisches Feld
            const figure = piece.dataset.type;
            const isWhitePiece = (figure === figure.toUpperCase());
            const pieceColor   = isWhitePiece ? "w" : "b";

            // Falsche Seite am Zug oder nur eigene Farbe erlaubt → kein Drag
            if (pieceColor !== this.sideToMove || (this.ownColorOnly && pieceColor !== this.myColor)) {
                return;
            }

            this.currentElement = piece;      
            this.selectedField = null; // Falls eine Feld über touch angemeldet war, lösche es  

            // >>> HIER der neue Hook: Figur wird „angehoben“
            if (typeof this.onMoveStart === "function") {
                this.onMoveStart(field, figure, pieceColor, 'mouse');
            }

            // Andere Figuren vorübergehend deaktivieren (kein Klick/Drag darauf)
            const allPieces = this.board.querySelectorAll(".piece");
            allPieces.forEach(p => {
                if (p !== piece) {
                    p.style.pointerEvents = "none";
                }
            });

            // Mausposition relativ zum Brett
            const boardRect = this.board.getBoundingClientRect();

            const cursorBoardX = event.clientX - boardRect.left;
            const cursorBoardY = event.clientY - boardRect.top;

            // aktuelles Figuren-Zentrum aus style.left/top (Board-Koordinaten)
            const pieceBoardX = parseFloat(piece.style.left);
            const pieceBoardY = parseFloat(piece.style.top);

            // Offset zwischen Maus und Figuren-Zentrum merken,
            // damit die Figur beim ersten Move NICHT springt.
            this.dragOffsetX = cursorBoardX - pieceBoardX;
            this.dragOffsetY = cursorBoardY - pieceBoardY;

            document.body.style.cursor = "grabbing";
            piece.style.zIndex = "9999";
            piece.classList.add("drag");

            document.addEventListener("mousemove", this.onMouseMove);
            document.addEventListener("mouseup", this.onMouseUp);
        });
    }

    // Bewegt die aktuell gezogene Figur mit der Maus
    onMouseMove(event) {
        if (!this.currentElement) return;

        const piece = this.currentElement;
        const boardRect = this.board.getBoundingClientRect();

        // Mausposition in Brett-Koordinaten
        const cursorBoardX = event.clientX - boardRect.left;
        const cursorBoardY = event.clientY - boardRect.top;

        // Figurenzentrum = Mausposition minus gespeicherten Offset
        const x = cursorBoardX - this.dragOffsetX;
        const y = cursorBoardY - this.dragOffsetY;

        piece.style.left = x + "px";
        piece.style.top  = y + "px";
    }

    // Wird beim Loslassen der Maus aufgerufen – validiert den Zug oder setzt zurück
    onMouseUp(event) {
        if (!this.currentElement) return;
        event.preventDefault();

        // Drag-Events wieder abmelden
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);

        // Andere Figuren wieder aktivieren
        const allPieces = this.board.querySelectorAll(".piece");
        allPieces.forEach(p => {
            p.style.pointerEvents = "";
        });

        const piece = this.currentElement;
        piece.classList.remove("drag");
        piece.style.zIndex = "";

        // Mittelpunkt der Figur in Brett-Koordinaten
        const centerX = parseFloat(piece.style.left);
        const centerY = parseFloat(piece.style.top);

        const boardSize = this.sizeField * 8;

        const fromField = Number(piece.dataset.position); // ursprüngliches logisches Feld

        // Hilfsfunktion: Figur optisch zurück ans alte Feld setzen
        const resetToOldPosition = () => {
            this.playSound('error');
            const { x: ox, y: oy } = this.getSquareCenter(fromField);
            piece.style.left = ox + "px";
            piece.style.top  = oy + "px";
        };

        // Liegt die Figur-Mitte noch auf dem Brett?
        if (centerX >= 0 && centerX <= boardSize && centerY >= 0 && centerY <= boardSize) {
            // Koordinaten -> logisches Feld (inkl. Flip-Korrektur)
            const toField = this.getFieldFromCoords(centerX, centerY);

            const isValid = this.validMoves.includes(toField);

            if (isValid) {

                this.finishUserMove(fromField, toField);

                piece.dataset.position = String(toField); // neues logisches Feld speichern
                const { x: nx, y: ny } = this.getSquareCenter(toField);
                piece.style.left = nx + "px";
                piece.style.top  = ny + "px";

                this.changesideToMove(); // Spieler am Zug wechseln
            } else {
                // Ungültiges Ziel innerhalb des Bretts → zurücksetzen
                resetToOldPosition();
            }
        } else {
            // Figur außerhalb des Bretts losgelassen → zurücksetzen
            resetToOldPosition();
        }

        this.clearHighlights();
        this.currentElement = null;
        document.body.style.cursor = "default";
    }

    // Setzt alle Figuren neu anhand ihres logischen Feldes (z.B. nach Flip oder Größenänderung)
    redrawAllPieces() {
        const pieces = this.board.querySelectorAll(".piece");
        pieces.forEach(piece => {
            const field = Number(piece.dataset.position);   // logisches Feld 0..63
            const { x, y } = this.getSquareCenter(field);  // Pixelkoordinaten
            piece.style.left = x + "px";
            piece.style.top  = y + "px";
        });
    }

    // Beliebige FEN setzen - aus dem Board heraus
    setFen(fenString) {
        this.clearAllPieces();
        this.setBoardSize();
        console.log(fenString);
        
        const fen = fenZuFigurenListe(fenString);
        this.sideToMove = fen.moveRight;
        this.setEnPassant(fen.enpassant);
        this.figurenListe = fen.figuresPosition;
        this.createPieces();
    }

    // Beliebige FEN setzen - aus dem GameController heraus
    renderFen(fenString) {
        this.clearAllPieces();
        this.setBoardSize();
        console.log(fenString);
        
        this.figurenListe = fenString;
        this.createPieces();
    }

    setSideToMove(side) {
        this.sideToMove = side;
    }

    setEnPassant(ep) {
        if (!ep || ep === "-") {
            this.enPassantField = null;
            return;
        }
        this.enPassantField = lanToField(ep);
    }
    
    // Wechselt die Seite, die am Zug ist
    changesideToMove() {
        this.sideToMove = (this.sideToMove === "w" ? "b" : "w");
    }

    // Spielt einen Sound ab, falls vorhanden und nicht geblockt
    playSound(type){
        if (!this.soundON) return;

        const audio = this.sounds[type];
        if (!audio) {
            console.warn('playSound: unbekannter Typ:', type);
            return;
        }

        // Kleiner Trick: Audio ein paar ms später abspielen,
        // damit der Frame mit der Figuren-Animation nicht gleichzeitig den Audio-Kram machen muss
        try {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        } catch (e) {
            console.warn('playSound: Fehler beim Abspielen:', type, e);
        }
    }

    // Flippt das Brett logisch + visuell
    flipBoard() {
        this.isFlipped = !this.isFlipped;
        this.clearHighlights(false);

        // CSS-Klasse z.B. für Brett-/Figurenrotation
        this.container.classList.toggle("flipped", this.isFlipped);

        // Figuren an neue Sicht anpassen
        this.redrawAllPieces();

        // Notation an neue Sicht anpassen (damit sie zum Brettbild passt)
        this.updateNotations(); 

    }

    // Aktualisiert data-notation der Squares abhängig von isFlipped,
    // damit die Koordinaten (a1..h8) zur aktuellen Brettansicht passen
    updateNotations() {
        const squares = this.board.querySelectorAll(".square");

        squares.forEach(sq => {
            const logicalField = Number(sq.dataset.field); // 0..63, immer Weiß-Sicht

            // logische file/rank aus 0..63 bestimmen
            let file = logicalField % 8;                        // 0..7 (0 = a)
            let rankFromBottom = Math.floor(logicalField / 8); // 0..7 (0 = 1. Reihe)

            // für die Anzeige ggf. spiegeln (Flip-Sicht)
            if (this.isFlipped) {
                file = 7 - file;
                rankFromBottom = 7 - rankFromBottom;
            }

            const fileLetter = String.fromCharCode('a'.charCodeAt(0) + file);
            const rankNumber = rankFromBottom + 1; // 1..8

            // Notation wie auf dem Brett-Sprite (z.B. a1..h8) aktualisieren
            sq.dataset.notation = `${fileLetter}${rankNumber}`;
        });
    }

    // 2-Tap-Steuerung für Touch:
    // 1. Tap auf Figur -> Auswahl + Worker rechnet Züge
    // 2. Tap auf Ziel-Feld (oder gegnerische Figur) -> Wenn in validMoves -> this.move(from, to)
    enableTouchTap() {
        if (!this.interactive) return;

        this.board.addEventListener("pointerdown", (event) => {
            if (event.pointerType !== "touch") return; // nur Touch, Maus bleibt bei Drag
            event.preventDefault();

            const rect = this.board.getBoundingClientRect();
            const boardX = event.clientX - rect.left;
            const boardY = event.clientY - rect.top;

            const piece = event.target.closest(".piece");

            if (piece) {
                const field  = Number(piece.dataset.position);
                const figure = piece.dataset.type;
                const isWhitePiece = (figure === figure.toUpperCase());
                const pieceColor   = isWhitePiece ? "w" : "b";

                // === ERSTER TAP: noch keine Figur ausgewählt ===
                if (!this.selectedPiece) {
                    // hier ist sideToMove / myColor wichtig
                    if (pieceColor !== this.sideToMove || (this.ownColorOnly && pieceColor !== this.myColor)) {
                        this.playSound('error');
                        return;
                    }

                    this.clearHighlights();
                    this.selectedPiece = piece;
                    this.selectedField = field;
                    this.validMoves    = [];

                    // >>> HIER der neue Hook: Figur wird „angehoben“
                    if (typeof this.onMoveStart === "function") {
                        this.onMoveStart(field, figure, pieceColor, 'touch');
                    }

                    return;
                }

                // === ZWEITER TAP: es IST schon eine Figur ausgewählt ===

                // 1) gleicher Stein -> Auswahl aufheben
                if (this.selectedPiece === piece) {
                    this.selectedPiece = null;
                    this.selectedField = null;
                    this.validMoves    = [];
                    this.clearHighlights();
                    return;
                }

                // Farbe der aktuell ausgewählten Figur
                const selectedFigure   = this.selectedPiece.dataset.type;
                const selectedIsWhite  = (selectedFigure === selectedFigure.toUpperCase());
                const selectedColor    = selectedIsWhite ? "w" : "b";

                // 2) gleiche Farbe -> Auswahl auf diese Figur UMSCHALTEN
                if (pieceColor === selectedColor) {
                    this.clearHighlights();

                    // Mit Zeitverzögerung, damit die Highlights erst ausfaden können
                    setTimeout(()=>{
                        this.selectedPiece = piece;
                        this.selectedField = field;
                        this.validMoves    = [];

                        // >>> HIER der neue Hook: Figur wird „angehoben“
                        if (typeof this.onMoveStart === "function") {
                            this.onMoveStart(field, figure, pieceColor, 'touch');
                        }

                    }, this.highlightFadeMs);

                    return;
                }

                // 3) gegnerische Farbe -> Zugversuch (Capture) auf dieses Feld
                this.handleTouchMove(field);
                return;
            }

            // --- Fall 2: Tap auf ein Feld (kein direktes Piece getroffen) ---
            if (!this.selectedPiece) {
                // nichts ausgewählt -> ignorieren
                return;
            }

            // Feld aus den Brett-Koordinaten ermitteln
            const targetField = this.getFieldFromCoords(boardX, boardY);
            this.handleTouchMove(targetField);
        });
    }

    // Führt für Touch einen Zug aus, wenn targetField in validMoves ist
    handleTouchMove(targetField) {
        if (!this.selectedPiece || this.selectedField == null) {
            this.playSound('error');
            return;
        }

        const toField = Number(targetField);

        if (!Array.isArray(this.validMoves) || !this.validMoves.includes(toField)) {
            this.playSound('error');
            return;
        }

        const fromField = this.selectedField;

        this.finishUserMove(fromField, toField);

        // High-Level-API: animiert + schlägt + wechselt sideToMove
        this.move(fromField, toField , true, () => {
            this.selectedPiece = null;
            this.selectedField = null;
            this.validMoves    = [];
            this.clearHighlights();
        });

        
    }

    // Beispiel: am Ende von onMouseUp oder deiner Move-Logik
    finishUserMove(oldField, newField) {
        const from = Number(oldField);
        const to   = Number(newField);
        let capturedPiece = this.getPieceAt(newField);
        const movingPiece = this.getPieceAt(oldField);

        if (movingPiece && movingPiece.dataset.type?.toLowerCase() === "p") {
            if (this.enPassantField != null && to === this.enPassantField && !capturedPiece) {
                const isWhite = movingPiece.dataset.type === movingPiece.dataset.type.toUpperCase();
                const capField = isWhite ? to - 8 : to + 8;
                const epPiece = this.getPieceAt(capField);
                if (epPiece) {
                    capturedPiece = epPiece;
                }
            }
        }

        if (movingPiece && movingPiece.dataset.type?.toLowerCase() === "k") {
            if (Math.abs(to - from) === 2) {
                this.moveCastleRook(from, to);
            }
        }

        if (typeof this.onUserMove === "function") {
            this.onUserMove(oldField, newField, capturedPiece);
        } else {
            console.warn("ChessBoard.onUserMove ist nicht gesetzt");
        }
    }

    moveCastleRook(fromField, toField) {
        const from = Number(fromField);
        const to = Number(toField);

        let rookFrom;
        let rookTo;

        if (to > from) {
            rookFrom = from + 3;
            rookTo = from + 1;
        } else {
            rookFrom = from - 4;
            rookTo = from - 1;
        }

        const rook = this.getPieceAt(rookFrom);
        if (!rook) {
            console.warn("moveCastleRook: kein Turm gefunden", { rookFrom, rookTo });
            return;
        }
        this.move(rookFrom, rookTo, false, null, { skipTurnChange: true });
    }

  


}
