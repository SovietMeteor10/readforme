import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    crx({ manifest }),
    viteStaticCopy({
      targets: [
        {
          src: [
            'node_modules/onnxruntime-web/dist/ort-wasm*.wasm',
            'node_modules/onnxruntime-web/dist/ort-wasm*.mjs',
            'node_modules/@huggingface/transformers/dist/ort-wasm*.wasm',
            'node_modules/@huggingface/transformers/dist/ort-wasm*.mjs'
          ],
          dest: 'assets/ort'
        }
      ]
    })
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        offscreen: 'src/offscreen/offscreen.html',
        popup: 'src/popup/popup.html',
        welcome: 'src/welcome/welcome.html'
      },
      output: {
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'kokoro-js', 'tesseract.js']
  },
  worker: {
    format: 'es'
  }
});
