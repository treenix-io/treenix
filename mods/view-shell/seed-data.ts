export const seedNodes = [
  {
    $path: 'sys/routes/v',
    $type: 't.view.shell',
    '#route': { $type: 't.route', wildcard: true, public: true },
    // SSR by default for /v/* — published static. Toggle off via SSR=0 env on server.
    '#site': { $type: 't.site', state: 'published', mode: 'static' },
    '#seo': { $type: 't.seo', title: 'Treenix' },
  },
];
