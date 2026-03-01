/**
 * Utility-Klasse zur Erkennung des Geräte-Typs.
 * Wird ausschließlich statisch verwendet, um im App-Start
 * die geeignete Eingabelogik (Desktop/Mobile) zu wählen.
 */
export default class DeviceCheck {
    constructor() {
        throw new Error('Diese Klasse sollte nicht instanziiert werden. Verwenden die statischen Methoden direkt.');
    }

    /** Liste bekannter Desktop-OS-Marker aus dem User-Agent. */
    static get desktopOSKeywords() {
        return ['Windows', 'Mac OS', 'Linux'];
    }

    /** Regex für typische Mobile-User-Agents. */
    static get mobileUserAgents() {
        return /iPhone|iPod|iPad|Android|webOS|BlackBerry|IEMobile|Opera Mini/i;
    }

    /** Touch-Erkennung als Fallback, falls der UA keine klare Aussage liefert. */
    static hasTouchScreen() {
        return 'ontouchstart' in window ||
            (navigator.maxTouchPoints > 0) ||
            window.matchMedia('(pointer: coarse)').matches;
    }

    /** Prüft, ob der User-Agent ein Desktop-Betriebssystem signalisiert. */
    static isDesktopOS() {
        const ua = navigator.userAgent;
        return this.desktopOSKeywords.some(os => ua.includes(os));
    }

    /**
     * Ermittelt, ob das Gerät als "mobil" behandelt werden soll.
     * Reihenfolge:
     * 1) explizite Mobile-User-Agents
     * 2) explizite Desktop-OS
     * 3) Touchscreen als letzter Fallback
     */
    static isMobile() {
        // 1. Check für explizite Mobile-Geräte
        if (this.mobileUserAgents.test(navigator.userAgent)) return true;

        // 2. Check für Desktop-Betriebssysteme
        if (this.isDesktopOS()) return false;

        // 3. Als Fallback: Touchscreen-Check
        return this.hasTouchScreen();
    }
}
