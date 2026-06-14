const { cache } = require("react");

const CACHE_NAME = 'ai-chat-v1';
const ASSETS = [
    '/',
    '/chat',
    '/chat.html',
    '/index.html',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    '/socket.io/socket.io.js' 

];

self.addEventListener('install', (event) => {
    event.waitUntil(
caches.open(CACHE_NAME).then((cache) = cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => response || fetch(event.request))
    );
});