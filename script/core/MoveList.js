export default class MoveList {
    constructor() {
        this.moves = [];
        this.index = -1;
    }

    addMove(move) {
        if (this.index < this.moves.length - 1) {
            this.moves = this.moves.slice(0, this.index + 1);
        }
        this.moves.push(move);
        this.index = this.moves.length - 1;
    }

    getAt(i) {
        return this.moves[i] || null;
    }

    getCurrent() {
        return this.moves[this.index] || null;
    }

    canUndo() {
        return this.index >= 0;
    }

    canRedo() {
        return this.index < this.moves.length - 1;
    }

    undo() {
        if (!this.canUndo()) return null;
        this.index--;
        if (this.index === -1) return null;
        return this.moves[this.index];
    }

    redo() {
        if (!this.canRedo()) return null;
        this.index++;
        return this.moves[this.index];
    }

    clear() {
        this.moves = [];
        this.index = -1;
    }
}

