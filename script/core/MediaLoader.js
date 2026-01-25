export default class MediaLoader {
    constructor(mediaUrls) {
        this.mediaUrls = mediaUrls;
        this.loadedMedia = {}; // Object für geladene Medien (Bilder und Audiodateien)
        this.progressBar = document.querySelector(".progress");
        this.progressText = document.querySelector(".progress-text");
    }

    loadMedia() {
        return Promise.all(this.mediaUrls.map(url => {
            return new Promise((resolve, reject) => {
                let media;

                // Lade eine Audiodatei (MP3)
                if (url.endsWith(".mp3")) {
                    media = new Audio();
                    media.src = url;
                    media.oncanplaythrough = () => {
                        const key = url.split("/").pop().split(".")[0];
                        this.loadedMedia[key] = media;
                        this.updateProgress(Object.keys(this.loadedMedia).length);
                        resolve();
                    };
                    media.onerror = () => reject(`Audio konnte nicht geladen werden: ${url}`);

                // Lade ein Bild (alle anderen Dateitypen)
                } else {
                    media = new Image();
                    media.src = url;
                    media.onload = () => {
                        const key = url.split("/").pop().split(".")[0];
                        this.loadedMedia[key] = media;
                        this.updateProgress(Object.keys(this.loadedMedia).length);
                        resolve();
                    };
                    media.onerror = () => reject(`Bild konnte nicht geladen werden: ${url}`);
                }
            });
        }));
    }

    updateProgress(loaded) {
        const progress = (loaded / this.mediaUrls.length) * 100;
        this.progressBar.style.width = `${progress}%`;
        this.progressText.innerText = `${Math.round(progress)}%`;

        // Wenn alle Medien geladen sind → Preloader ausblenden, Board anzeigen
        if (loaded === this.mediaUrls.length) {
            const preloader = document.querySelector(".preloader");
            const content = document.querySelector(".boardContainer");
            setTimeout(() => {
                preloader.style.display = "none";
                content.style.display = "flex";
            }, 500);
        }
    }

    getLoadedMedia() {
        return this.loadedMedia;
    }
}