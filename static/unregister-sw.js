// Emergency service worker unregistration script
// This file can be loaded directly to force unregister all service workers

if ('serviceWorker' in navigator) {
    console.log('[SW-Unregister] Starting emergency unregistration...');

    navigator.serviceWorker
        .getRegistrations()
        .then(function (registrations) {
            if (registrations.length === 0) {
                console.log('[SW-Unregister] No service workers found');
                return;
            }

            console.log(
                '[SW-Unregister] Found ' +
                    registrations.length +
                    ' service worker(s), unregistering...',
            );

            for (var i = 0; i < registrations.length; i++) {
                registrations[i]
                    .unregister()
                    .then(function (success) {
                        if (success) {
                            console.log(
                                '[SW-Unregister] Service worker #' +
                                    i +
                                    ' unregistered successfully',
                            );
                        }
                    })
                    .catch(function (err) {
                        console.error(
                            '[SW-Unregister] Failed to unregister service worker #' + i + ':',
                            err,
                        );
                    });
            }

            // Clear all caches
            caches
                .keys()
                .then(function (cacheNames) {
                    console.log('[SW-Unregister] Clearing ' + cacheNames.length + ' cache(s)...');
                    return Promise.all(
                        cacheNames.map(function (cacheName) {
                            console.log('[SW-Unregister] Deleting cache: ' + cacheName);
                            return caches.delete(cacheName);
                        }),
                    );
                })
                .then(function () {
                    console.log('[SW-Unregister] All caches cleared');
                    console.log('[SW-Unregister] Please refresh the page');

                    // Auto-refresh after a short delay
                    setTimeout(function () {
                        console.log('[SW-Unregister] Auto-refreshing...');
                        window.location.reload(true);
                    }, 1000);
                })
                .catch(function (err) {
                    console.error('[SW-Unregister] Failed to clear caches:', err);
                });
        })
        .catch(function (err) {
            console.error('[SW-Unregister] Failed to get registrations:', err);
        });
} else {
    console.log('[SW-Unregister] Service workers not supported');
}
