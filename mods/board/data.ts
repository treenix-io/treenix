/** Build the shared fractional order component for a task or column. */
export const orderComponent = (order: number) => ({ $type: 'board.order' as const, order });

/** Create a Board column with a native query over its matching task status. */
export function columnData(label: string, order: number, source: string, status: string) {
  return {
    label,
    color: 'border-border',
    '#order': orderComponent(order),
    '#mount': { $type: 't.mount.query', pattern: '', source, match: { status } },
  };
}
