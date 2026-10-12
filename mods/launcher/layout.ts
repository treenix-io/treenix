export interface LauncherItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Place a new shortcut after the last occupied row in the saved layout. */
export function appendLauncherItem(layout: string, columns: number, id: string): string {
  const items: LauncherItem[] = JSON.parse(layout);
  const maxY = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const lastRow = items.filter((item) => item.y + item.h === maxY);
  const nextX = lastRow.reduce((max, item) => Math.max(max, item.x + item.w), 0);

  items.push({
    i: id,
    x: nextX < columns ? nextX : 0,
    y: nextX < columns ? Math.max(0, maxY - 1) : maxY,
    w: 1,
    h: 1,
  });

  return JSON.stringify(items);
}

/** Remove the layout entry together with its shortcut. */
export function removeLauncherItem(layout: string, id: string): string {
  const items: LauncherItem[] = JSON.parse(layout);
  return JSON.stringify(items.filter((item) => item.i !== id));
}
