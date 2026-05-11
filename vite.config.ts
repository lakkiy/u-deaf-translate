import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

// CRXJS 负责解析 manifest.json 里声明的 content_scripts，
// 自动把 src/*.ts 打包并写到 dist/，开发模式下自动热重载。
export default defineConfig({
  plugins: [crx({ manifest })],
});
