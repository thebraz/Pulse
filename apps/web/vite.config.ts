import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
export default defineConfig({plugins:[tailwind()],resolve:{dedupe:['zod','react','react-dom']},build:{sourcemap:false}});
