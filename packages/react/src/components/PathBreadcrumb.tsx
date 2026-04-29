import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '#components/ui/breadcrumb';

type PathBreadcrumbProps = {
  path: string;
  onSelect: (path: string) => void;
  className?: string;
  listClassName?: string;
  itemClassName?: string;
  linkClassName?: string;
  pageClassName?: string;
  separatorClassName?: string;
};

export function PathBreadcrumb({
  path,
  onSelect,
  className = 'mb-2 text-xs',
  listClassName = 'text-xs gap-1 sm:gap-1',
  itemClassName,
  linkClassName = 'cursor-pointer',
  pageClassName,
  separatorClassName = '[&>svg]:size-3',
}: PathBreadcrumbProps) {
  const parts = path.split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: 'root', path: '/' }];
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    crumbs.push({ label: p, path: cur });
  }
  const last = crumbs.length - 1;

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList className={listClassName}>
        {crumbs.map((c, i) => (
          <span key={c.path} className="contents">
            {i > 0 && <BreadcrumbSeparator className={separatorClassName} />}
            <BreadcrumbItem className={itemClassName}>
              {i === last
                ? <BreadcrumbPage className={pageClassName}>{c.label}</BreadcrumbPage>
                : <BreadcrumbLink className={linkClassName} onClick={() => onSelect(c.path)}>{c.label}</BreadcrumbLink>}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
