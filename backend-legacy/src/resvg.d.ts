/**
 * Minimal ambient types for @resvg/resvg-js (the package ships no .d.ts).
 * Only the surface used by image-gen.ts is declared.
 */
declare module '@resvg/resvg-js' {
  export interface ResvgRenderOptions {
    fitTo?: { mode: 'original' | 'width' | 'height' | 'zoom'; value?: number };
    background?: string;
  }

  export interface RenderedSvg {
    width: number;
    height: number;
    asPng(): Buffer;
  }

  export class Resvg {
    constructor(svg: string | Uint8Array, options?: ResvgRenderOptions);
    render(): RenderedSvg;
    toString(): string;
  }
}
