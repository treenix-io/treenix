// SSR opt-in for view-shell. The single view in view.tsx registers itself for
// both `react` and `site` contexts; we just need virtual:mod-site-views to
// pick this barrel up so Vite ssrLoadModule loads view.tsx server-side.
import './view';
