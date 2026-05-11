export function registerOfflineServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  const workerUrl = new URL(`${import.meta.env.BASE_URL}offline-sw.js`, window.location.origin);

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(workerUrl, { scope: import.meta.env.BASE_URL })
      .catch((error: unknown) => {
        console.warn("DJ1000 offline mode could not be enabled.", error);
      });
  });
}
