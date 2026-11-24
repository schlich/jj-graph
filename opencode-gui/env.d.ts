// Vite's `?inline` CSS import, as gui.tsx uses it.
declare module "*.css?inline" {
  const css: string
  export default css
}
