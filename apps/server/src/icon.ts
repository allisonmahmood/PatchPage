/**
 * PatchPage's icon, for browser tabs, bookmarks, and link previews. The SVG is
 * the repository's favicon.svg, kept identical by a test. The PNG is that SVG at
 * 512px on the paper color, for the link previews and home-screen icons that do
 * not take SVG:
 *
 *   rsvg-convert -w 512 -h 512 -b "#fffdf4" favicon.svg | magick - -strip -colors 32 PNG8:-
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">PatchPage icon</title>
  <desc id="desc">A rounded red patch with a black outline, black offset shadow, and a small corner mark.</desc>
  <rect x="114" y="110" width="286" height="286" rx="82" fill="#15130F" transform="rotate(-6 257 253) translate(22 22)"/>
  <rect x="114" y="110" width="286" height="286" rx="82" fill="#E94B35" stroke="#15130F" stroke-width="30" transform="rotate(-6 257 253)"/>
  <path d="M256 180H326V250" fill="none" stroke="#15130F" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" transform="rotate(-6 291 215)"/>
</svg>
`;

export const ICON_PNG = Buffer.from(
  "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",
  "base64"
);
