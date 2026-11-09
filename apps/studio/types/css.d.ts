// Next bundles global stylesheets but ships no ambient declaration for them,
// and a side-effect import of an untyped module is an error under this
// tsconfig. One line, imported once, from app/layout.tsx.
declare module '*.css';
