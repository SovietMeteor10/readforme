import type { ErrorPayload, HighlightPayload, ProgressPayload } from '../../shared/types';

type PlayerState = 'loading' | 'playing' | 'paused' | 'error' | 'hidden';

export class ReadAloudPlayer {
  private root: HTMLElement;
  private title: HTMLElement;
  private fill: HTMLElement;
  private modelProgress: HTMLElement;
  private modelBar: HTMLElement;
  private modelLabel: HTMLElement;
  private playPause: HTMLButtonElement;
  private speed: HTMLSelectElement;
  private voice: HTMLSelectElement;

  constructor() {
    const existing = document.getElementById('readaloud-player');
    if (existing) existing.remove();

    const wrapper = document.createElement('div');
    wrapper.id = 'readaloud-player';
    wrapper.dataset.state = 'loading';
    wrapper.innerHTML = `
      <div class="ra-track">
        <div class="ra-title" id="ra-title">Preparing page...</div>
        <div class="ra-progress-bar"><div class="ra-progress-fill" id="ra-progress-fill"></div></div>
      </div>
      <div class="ra-controls">
        <button class="ra-btn" id="ra-prev" title="Previous paragraph">⏮</button>
        <button class="ra-btn ra-btn-primary" id="ra-playpause" title="Play/Pause">▶</button>
        <button class="ra-btn" id="ra-next" title="Next paragraph">⏭</button>
        <select id="ra-speed" title="Playback speed">
          <option value="0.75">0.75x</option>
          <option value="1" selected>1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
          <option value="3">3x</option>
        </select>
        <select id="ra-voice" title="Voice">
          <option value="af_heart">Heart</option>
          <option value="af_bella">Bella</option>
          <option value="am_adam">Adam</option>
          <option value="bf_emma">Emma</option>
          <option value="bm_george">George</option>
        </select>
        <button class="ra-btn ra-btn-close" id="ra-close" title="Close">✕</button>
      </div>
      <div class="ra-model-progress" id="ra-model-progress" style="display:none">
        <div class="ra-model-bar" id="ra-model-bar"></div>
        <span class="ra-model-label" id="ra-model-label">Downloading voices (one-time, ~86MB)...</span>
      </div>
    `;

    document.documentElement.append(wrapper);
    this.root = wrapper;
    this.title = wrapper.querySelector('#ra-title') as HTMLElement;
    this.fill = wrapper.querySelector('#ra-progress-fill') as HTMLElement;
    this.modelProgress = wrapper.querySelector('#ra-model-progress') as HTMLElement;
    this.modelBar = wrapper.querySelector('#ra-model-bar') as HTMLElement;
    this.modelLabel = wrapper.querySelector('#ra-model-label') as HTMLElement;
    this.playPause = wrapper.querySelector('#ra-playpause') as HTMLButtonElement;
    this.speed = wrapper.querySelector('#ra-speed') as HTMLSelectElement;
    this.voice = wrapper.querySelector('#ra-voice') as HTMLSelectElement;
    this.bindControls();
    this.enableDrag();
  }

  getSettings() {
    return { voice: this.voice.value, speed: Number(this.speed.value) };
  }

  setState(state: PlayerState, title?: string) {
    this.root.dataset.state = state;
    if (title) this.title.textContent = title;
    this.playPause.textContent = state === 'playing' ? '▐▐' : state === 'loading' ? '◌' : '▶';
  }

  setProgress(current: number, total: number) {
    this.fill.style.width = total ? `${Math.round((current / total) * 100)}%` : '0%';
    this.title.textContent = total ? `Paragraph ${current} of ${total}` : 'Preparing page...';
  }

  setModelProgress(payload: ProgressPayload) {
    this.modelProgress.style.display = 'block';
    const total = payload.total || 0;
    const loaded = payload.loaded || 0;
    const percent = payload.progress ?? (total ? (loaded / total) * 100 : 0);
    this.modelBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    this.modelLabel.textContent = percent
      ? `Downloading voices (one-time, ~86MB) ${Math.round(percent)}%`
      : 'Downloading voices (one-time, ~86MB)...';
  }

  markModelReady() {
    this.modelProgress.style.display = 'none';
  }

  showError(error: ErrorPayload) {
    this.setState('error', error.message);
    this.modelProgress.style.display = 'none';
  }

  highlight(payload: HighlightPayload) {
    document.querySelectorAll('.ra-highlight').forEach((el) => el.classList.remove('ra-highlight'));
    if (!payload.paragraphId) return;
    const target = document.querySelector(`[data-readaloud-id="${CSS.escape(payload.paragraphId)}"]`);
    if (target instanceof HTMLElement) {
      target.classList.add('ra-highlight');
      const rect = target.getBoundingClientRect();
      const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
      if (!inView) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    this.setState('playing');
    this.setProgress(payload.index + 1, payload.total);
  }

  private bindControls() {
    this.playPause.addEventListener('click', () => {
      const next = this.root.dataset.state === 'playing' ? 'PAUSE' : 'RESUME';
      chrome.runtime.sendMessage({ type: next });
      this.setState(next === 'PAUSE' ? 'paused' : 'playing');
    });
    this.root.querySelector('#ra-close')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP' });
      clearAllHighlights();
      this.setState('hidden');
    });
    this.speed.addEventListener('change', () => chrome.runtime.sendMessage({ type: 'SET_SPEED', payload: Number(this.speed.value) }));
    this.voice.addEventListener('change', () => chrome.runtime.sendMessage({ type: 'SET_VOICE', payload: this.voice.value }));
  }

  private enableDrag() {
    const handle = this.root.querySelector('.ra-track') as HTMLElement;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startBottom = 0;

    handle.addEventListener('mousedown', (event) => {
      startX = event.clientX;
      startY = event.clientY;
      startRight = Number.parseFloat(getComputedStyle(this.root).right);
      startBottom = Number.parseFloat(getComputedStyle(this.root).bottom);
      const move = (moveEvent: MouseEvent) => {
        this.root.style.right = `${Math.max(8, startRight - (moveEvent.clientX - startX))}px`;
        this.root.style.bottom = `${Math.max(8, startBottom - (moveEvent.clientY - startY))}px`;
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
}

function clearAllHighlights() {
  document.querySelectorAll('.ra-highlight').forEach((el) => el.classList.remove('ra-highlight'));
  document.querySelectorAll('.ra-word-active').forEach((el) => el.classList.remove('ra-word-active'));
  document.querySelectorAll('[data-readaloud-id]').forEach((el) => el.removeAttribute('data-readaloud-id'));
}
