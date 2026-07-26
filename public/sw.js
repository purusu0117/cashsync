// CashSync Service Worker（プッシュ通知の受信・表示）
self.addEventListener("push", (event) => {
  let data = { title: "CashSync", body: "" };
  try {
    data = event.data.json();
  } catch (e) {
    /* noop */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "CashSync", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
