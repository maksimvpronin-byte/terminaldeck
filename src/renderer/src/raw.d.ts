/** A file imported as its text, which Vite does for any `?raw` import. */
declare module '*?raw' {
  const text: string
  export default text
}
