/**
 * PixelPort is injected into engine image operations. The engine owns geometry,
 * sampling and pixel rules; its caller owns decoding/encoding and canvas life.
 *
 * @typedef {object} PixelPort
 * @property {(width: number, height: number) => object} createCanvas Canvas 2D surface
 * @property {(bytes: Uint8Array) => Promise<object>} loadImage Image with width/height and optional close()
 * @property {(canvas: object) => Promise<Uint8Array>} encode Encode PNG pixels
 *
 * Browser bitmap and DOM-image adapters remain separate: premultiplication and
 * texture decoding must preserve their existing behavior. Node tests inject a
 * native canvas adapter. Neither adapter is a default inside engine/.
 */
export {};
