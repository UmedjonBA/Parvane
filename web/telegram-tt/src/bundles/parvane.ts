// Parvane (B2): разделы оболочки и палитра — отдельным бандлом, вне критического пути старта.
// Грузится при первом открытии раздела или палитры и заранее, через несколько секунд после Main
export { default as Planner } from '../components/parvane/planner/Planner';
export { default as Knowledge } from '../components/parvane/notes/Knowledge';
export { default as Cloud } from '../components/parvane/cloud/Cloud';
export { default as ParvanePalette } from '../components/parvane/palette/ParvanePalette';
