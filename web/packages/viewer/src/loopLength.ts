/**
 * PLACEHOLDER (not the game's): how long a bed or an emitter is rendered before it loops, and the crossfade that joins
 * the end to the start (web/docs/research/81 §10). The console runs the grains for ever; a buffer this long repeats
 * past notice. Its own module so the worker, which renders the loops, and the page, which plays them, share it.
 */
export const LOOP_SECONDS_PLACEHOLDER = 12;
export const LOOP_FADE_SECONDS_PLACEHOLDER = 1;
