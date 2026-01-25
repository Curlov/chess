import FenFactory from './FenFactory.js';

export default class ChessBoard {
    constructor(containerID, loadedMedia, device, moveWorker, options = {}) {
        // Optionen mit Defaults – so kannst du das Brett flexibel konfigurieren
        const {
            interactive = true,      // Brett reagiert auf Maus (Drag) oder ist passiv
            ownColorOnly = true,     // darfst du nur deine eigene Farbe ziehen?
            showLegalMoves = true,   // erlaubte Züge optisch markieren
            showMoves = true,        // Animations-/Zug-Highlighting
            soundON = false,         // Soundeffekte an/aus
            sizeField = 60,          // Kantenlänge eines Feldes in px
            isFlipped = false        // Startansicht: aus Weiß- oder Schwarz-Sicht
        } = options;
        
        // DOM-Elemente
        this.container = document.querySelector(containerID);    // äußerer Container (boardContainer)
        this.board     = this.container.querySelector(".board"); // inneres 8x8-Grid

        // Bindings für Event-Handler (damit "this" stimmt, wenn als Callback verwendet)
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp   = this.onMouseUp.bind(this);

        // Drag-State
        this.currentElement = null;  // aktuell gezogene Figur
        this.dragOffsetX    = 0;     // Mausversatz zur Figurenmitte (X)
        this.dragOffsetY    = 0;     // Mausversatz zur Figurenmitte (Y)

        // Konfiguration / Zustände
        this.interactive     = interactive;
        this.ownColorOnly    = ownColorOnly;
        this.showLegalMoves  = showLegalMoves;
        this.showMoves       = showMoves;
        this.soundON         = soundON;
        this.sizeField       = sizeField;   
        this.isFlipped       = isFlipped; 
        this.device          = device;
        this.moveWorker      = moveWorker;

        // Mapping von FEN-Figurentyp → Key im geladenen Media-Objekt
        this.fenTypeToImgType = {
            "p": "bp", "r": "br", "n": "bn", "b": "bb", "q": "bq", "k": "bk",
            "P": "wp", "R": "wr", "N": "wn", "B": "wb", "Q": "wq", "K": "wk"
        };

        // Assets (Bilder, Sounds, Board-Sprite usw.)
        this.loadedMedia = loadedMedia;

        // FEN-/Spielzustand
        this.fen        = {};   // wird später von FenFactory befüllt
        this.validMoves = [];   // vom Worker berechnete legalen Züge für die aktuell angefasste Figur
        this.myColor    = null; // "w" oder "b" – Spielerfarbe (wird in createPieces gesetzt)

        // Antwort vom Move-Worker verarbeiten (legalen Züge empfangen)
        if (this.moveWorker) {
            this.moveWorker.onmessage = (e) => {
                // Worker schickt Array von Ziel-Feldern (Bitboard-Indizes 0..63)
                this.validMoves = Array.isArray(e.data) ? e.data : [];
                
                // Optionale visuelle Hervorhebung der erlaubten Züge
                if (this.showLegalMoves) {
                    this.clearHighlights();
                    this.highlight(this.validMoves);
                }

                console.log("erlaubte Züge", this.validMoves);
            };
        }

        // CSS-Variablen für Größen setzen und ggf. existierende Figuren neu positionieren
        this.setBoardSize();
        // Grid-Struktur (64 Squares) + Background setzen + Drag aktivieren
        this.createBoard();

        // Interaktivität auch visuell kenntlich machen
        if (!this.interactive) {
            this.board.classList.add("nonInteractive");
        } else {
            this.board.classList.remove("nonInteractive");
        }
    }

    // Berechnet und setzt die Größen für Brett + Ränder + Figuren via CSS-Variablen
    setBoardSize() {
        const sizeAllFields  = this.sizeField * 8;           // 8 Felder nebeneinander
        const sizeRims       = this.sizeField;               // Rand = 1 Feldbreite
        const sizeChessBoard = sizeAllFields + sizeRims;     // Gesamtbrett inkl. Rand
        const sizePieces     = (this.sizeField / 100) * 80;  // Figuren etwas kleiner als Feld

        const root = this.container;

        // CSS-Custom-Properties am Container setzen
        root.style.setProperty('--field',      `${this.sizeField}px`);
        root.style.setProperty('--allFields',  `${sizeAllFields}px`);
        root.style.setProperty('--rims',       `${sizeRims}px`);
        root.style.setProperty('--chessBoard', `${sizeChessBoard}px`);
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

                this.board.appendChild(square);
            }
        }

        // Drag-Logik aktivieren
        this.enableDrag();
        // Notation optional an Flip-Sicht anpassen (z.B. damit sie mit dem Brett-Sprite übereinstimmt)
        this.updateNotations(); 
    }

    // Erzeugt alle Figuren anhand der aktuellen FEN-Daten in this.fen
    createPieces() {
        // Spielerfarbe ist "wer ist am Zug" aus der FEN
        this.myColor = this.fen.moveRight;

        const pieces = this.fen.figuresPosition;

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

    // Entfernt eine Figur von einem bestimmten Feld
    removePiece(field) {
        const f = Number(field);
        const piece = this.getPieceAt(f);
        if (!piece) {
            console.warn("Keine Figur auf Feld", f);
            return;
        }
        piece.remove();
    }

    // High-Level API: Figur von Feld A nach Feld B bewegen (mit Animation)
    move(fromField, toField, onDone) {
        const piece = this.getPieceAt(fromField); 
        if (!piece) {
            console.warn("Keine Figur auf Feld:", fromField);
            return;
        }

        this.animateMovePiece(piece, fromField, toField, onDone);
        this.changeMoveRight();
    }

    // Animiert eine Figur von "from" nach "to"
    animateMovePiece(piece, fromField, toField, onDone) {
        const from = Number(fromField);
        const to   = Number(toField);

        // Optional: Startfeld / Zug visualisieren
        if (this.showMoves) {
            this.clearHighlights(true);
            this.highlight(from, "f");
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
            const destPiece = this.getPieceAt(to);
            if (destPiece && destPiece !== piece) {
                this.removePiece(to);
            }

            // Endposition sauber setzen (zentriert auf Ziel-Feld)
            const { x: fx, y: fy } = this.getSquareCenter(to);
            piece.style.left = fx + "px";
            piece.style.top  = fy + "px";

            piece.style.zIndex = "";
            piece.classList.remove("moving");
            piece.dataset.position = String(to); // logisches Zielfeld speichern

            // Andere Figuren wieder klickbar machen
            allPieces.forEach(p => p.style.pointerEvents = "");

            // Optionaler Move-Sound
           	if (this.soundON) this.playSound('move');

           	// Optional: Zielfeld hervorheben
           	if (this.showMoves) {
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
            this.board.querySelectorAll(".square.f-color, .square.c-color, .square.show")
        );

        if (squares.length === 0) return;

        // Sichtbarkeit der Overlays wegnehmen (CSS-Transition)
        squares.forEach(sq => sq.classList.remove("show"));

        if (immediate) {
            // Direkt alles weg (ohne Animation)
            squares.forEach(sq => sq.classList.remove("f-color", "c-color"));
        } else {
            // Nach kurzer Zeit Farbklassen entfernen (passt zur CSS-Transition)
            setTimeout(() => {
                squares.forEach(sq => sq.classList.remove("f-color", "c-color"));
            }, 100);
        }
    }

    // Markiert ein oder mehrere Felder als Highlights (z.B. legale Züge oder letzter Zug)
    highlight(fields, type = "f") {
        const colorClass = (type === "f") ? "f-color" : "c-color"; // f = mögliche Züge, c = letzter Zug / Schach

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
            if (pieceColor !== this.fen.moveRight || (this.ownColorOnly && pieceColor !== this.myColor)) {
                return;
            }

            this.currentElement = piece;

            // Worker mit Startfeld + Figurentyp füttern, damit er legale Züge berechnet
            if (this.moveWorker) {
                this.moveWorker.postMessage({ field, figure });
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

        const oldField = Number(piece.dataset.position); // ursprüngliches logisches Feld

        // Hilfsfunktion: Figur optisch zurück ans alte Feld setzen
        const resetToOldPosition = () => {
            this.playSound('error');
            const { x: ox, y: oy } = this.getSquareCenter(oldField);
            piece.style.left = ox + "px";
            piece.style.top  = oy + "px";
        };

        // Liegt die Figur-Mitte noch auf dem Brett?
        if (centerX >= 0 && centerX <= boardSize && centerY >= 0 && centerY <= boardSize) {
            // Koordinaten -> logisches Feld (inkl. Flip-Korrektur)
            const field = this.getFieldFromCoords(centerX, centerY);
            const isValid = this.validMoves.includes(field);

            if (isValid) {
                // Neuer Zug ist in den erlaubten Zügen
                this.playSound('move');

                piece.dataset.position = String(field); // neues logisches Feld speichern
                const { x: nx, y: ny } = this.getSquareCenter(field);
                piece.style.left = nx + "px";
                piece.style.top  = ny + "px";

                this.changeMoveRight(); // Spieler am Zug wechseln
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

    // Lädt zufälliges Puzzle-FEN und erzeugt Figuren
    async setFenPuzzle() {
        this.setBoardSize();
        this.fen = await FenFactory.fromPuzzle(); 
        this.createPieces(); 
    }

    // Startstellung (klassische Grundaufstellung)
    setFenStart() {
        this.setBoardSize();
        this.fen = FenFactory.fromStart();
        this.createPieces();
    }

    // Beliebige FEN setzen
    setFenVariable(fenString) {
        this.setBoardSize();
        this.fen = FenFactory.fenZuFigurenListe(fenString);
        this.createPieces();
    }
    
    // Wechselt die Seite, die am Zug ist
    changeMoveRight() {
        this.fen.moveRight = (this.fen.moveRight === "w" ? "b" : "w");
    }

    // Spielt einen Sound ab, falls vorhanden und nicht geblockt
    playSound(type){
        if (this.loadedMedia && this.loadedMedia[type]) {
            this.loadedMedia[type].play().catch(() => {});
        }
    }

    // Flippt das Brett logisch + visuell
    flipBoard() {
        this.isFlipped = !this.isFlipped;

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
            let file = logicalField % 8;                     // 0..7 (0 = a)
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

}
