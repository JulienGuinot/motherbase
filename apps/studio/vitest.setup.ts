import '@testing-library/jest-dom/vitest';

// jsdom implements no layout, so it ships no scrollIntoView at all. Any
// component that keeps a highlighted row in view (Select, the command
// palette) throws on mount without this, which is a gap in the environment
// rather than anything the component should defend against.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
