import { DEFAULT_SPEED, DEFAULT_VOICE } from '../shared/constants';

const voice = document.getElementById('voice') as HTMLSelectElement;
const speed = document.getElementById('speed') as HTMLInputElement;
const speedValue = document.getElementById('speed-value') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const reset = document.getElementById('reset') as HTMLButtonElement;

void chrome.storage.local.get({ voice: DEFAULT_VOICE, speed: DEFAULT_SPEED }).then((settings) => {
  voice.value = String(settings.voice);
  speed.value = String(settings.speed);
  speedValue.textContent = `${settings.speed}x`;
});

voice.addEventListener('change', () => {
  void chrome.storage.local.set({ voice: voice.value });
});

speed.addEventListener('input', () => {
  speedValue.textContent = `${speed.value}x`;
  void chrome.storage.local.set({ speed: Number(speed.value) });
});

reset.addEventListener('click', async () => {
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  }
  status.textContent = 'Local cache cleared. Voices will download again on next use.';
});
