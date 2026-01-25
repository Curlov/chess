// === Debug-Logger für Handy-Konsole ===
(function () {
    const logDiv = document.getElementById('log');

    function logToPanel(...args) {
        if (!logDiv) return;
        const msg = args.map(a => {
            try {
                if (a instanceof Error) {
                    return a.message + '\n' + a.stack;
                }
                return typeof a === 'string' ? a : JSON.stringify(a);
            } catch {
                return String(a);
            }
        }).join(' ');
        logDiv.textContent += msg + '\n';
        logDiv.scrollTop = logDiv.scrollHeight;
    }

    const origLog = console.log;
    const origErr = console.error;

    console.log = (...args) => {
        origLog(...args);
        logToPanel('[LOG]', ...args);
    };

    console.error = (...args) => {
        origErr(...args);
        logToPanel('[ERROR]', ...args);
    };

    window.addEventListener('error', (e) => {
        logToPanel('[UNCAUGHT ERROR]', e.message, e.filename + ':' + e.lineno);
    });

    window.addEventListener('unhandledrejection', (e) => {
        logToPanel('[UNHANDLED PROMISE]', e.reason);
    });
})();
// === Ende Debug-Logger ===