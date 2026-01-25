export default class DeviceCheck {
    constructor() {
        throw new Error('Diese Klasse sollte nicht instanziiert werden. Verwenden die statischen Methoden direkt.');
    }

    static get desktopOSKeywords() {
        return ['Windows', 'Mac OS', 'Linux'];
    }

    static get mobileUserAgents() {
        return /iPhone|iPod|iPad|Android|webOS|BlackBerry|IEMobile|Opera Mini/i;
    }

    static hasTouchScreen() {
        return 'ontouchstart' in window ||
            (navigator.maxTouchPoints > 0) ||
            window.matchMedia('(pointer: coarse)').matches;
    }

    static isDesktopOS() {
        const ua = navigator.userAgent;
        return this.desktopOSKeywords.some(os => ua.includes(os));
    }

    static isMobile() {
        // 1. Check für explizite Mobile-Geräte
        if (this.mobileUserAgents.test(navigator.userAgent)) return true;

        // 2. Check für Desktop-Betriebssysteme
        if (this.isDesktopOS()) return false;

        // 3. Als Fallback: Touchscreen-Check
        return this.hasTouchScreen();
    }
}