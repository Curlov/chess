/**
 * Einfache Zug-Historie mit Undo/Redo-Index.
 * Jeder Eintrag repräsentiert genau einen Halbzug.
 */
export default class MoveList {
    constructor() {
        this.moves = [];
        this.index = -1;
    }

    /**
     * Fügt einen Zug am aktuellen Ende ein.
     * Falls zuvor zurückgespult wurde, wird der "Redo-Zweig" abgeschnitten.
     */
    addMove(move) {
        if (this.index < this.moves.length - 1) {
            this.moves = this.moves.slice(0, this.index + 1);
        }
        this.moves.push(move);
        this.index = this.moves.length - 1;
    }

    /** Gibt den History-Eintrag an Position i zurück (oder null). */
    getAt(i) {
        return this.moves[i] || null;
    }

    /** Liefert den aktuell aktiven History-Eintrag. */
    getCurrent() {
        return this.moves[this.index] || null;
    }

    /** Prüft, ob mindestens ein Undo-Schritt möglich ist. */
    canUndo() {
        return this.index >= 0;
    }

    /** Prüft, ob ein Redo-Schritt möglich ist. */
    canRedo() {
        return this.index < this.moves.length - 1;
    }

    /** Geht einen Schritt zurück und liefert den neuen aktuellen Eintrag. */
    undo() {
        if (!this.canUndo()) return null;
        this.index--;
        if (this.index === -1) return null;
        return this.moves[this.index];
    }

    /** Geht einen Schritt vor und liefert den neuen aktuellen Eintrag. */
    redo() {
        if (!this.canRedo()) return null;
        this.index++;
        return this.moves[this.index];
    }

    /** Setzt die komplette Historie zurück. */
    clear() {
        this.moves = [];
        this.index = -1;
    }
}
