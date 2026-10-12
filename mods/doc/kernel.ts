import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import type { TypeDef } from '@treenx/core/kernel/types';
import { nativeSeed } from '#prefab/seed';
import { mdToTiptap, tiptapToMd, type TiptapNode } from './markdown';
import { markdownCodec } from './native-codec';
import page from './schemas/doc.page.json' with { type: 'json' };
import frontmatter from './schemas/doc.frontmatter.json' with { type: 'json' };

const owner = '@treenx/mods/doc';
const welcomeMd = `A rich document with **bold**, *italic*, and \`code\`.

- Stored as Tiptap JSON
- Editable with WYSIWYG toolbar
- Supports embedded Treenix components via /slash commands`;

/** Publish documents and pure codecs without the retiring filesystem executor. */
export default function createNativeDoc(): NativeModuleDeployment {
  const types = [page, frontmatter].map(
    (schema): TypeDef => ({
      name: schema.$id,
      module: owner,
      version: 0,
      security: 'ordinary',
      schema,
      actions: {},
    }),
  );
  const demo = nativeSeed('doc', [
    {
      $path: 'welcome',
      $type: 'doc.page',
      title: 'Welcome to Docs',
      content: mdToTiptap(welcomeMd),
    },
  ]);
  const seeds = {
    sources: [
      ...demo.sources,
      {
        $path: '/sys/mods/doc/prefabs/library',
        $type: 't.prefab',
        mod: 'doc',
        name: 'library',
        nodes: [
          {
            $path: '.',
            $type: 't.mount-point',
            '#mount': { $type: 't.mount.rawfs', pattern: '', directory: 'docs', external: 'none' },
            '#groups': { $type: 't.groups', list: ['admins'] },
          },
        ],
      },
    ],
    prefabs: demo.prefabs.map((prefab) => ({
      ...prefab,
      source: { ...prefab.source, $path: '/sys/mods/doc/prefabs/demo', name: 'demo' },
    })),
  };
  return {
    manifest: {
      id: owner,
      types,
      security: [],
      open: [
        {
          type: 'doc.page',
          context: 'text',
          handler: (data: { title: string; content: TiptapNode }) =>
            [data.title ? `# ${data.title}` : '', tiptapToMd(data.content)].join('\n\n'),
        },
      ],
    },
    rawfsCodecs: { 'text/markdown': markdownCodec },
    seeds,
  };
}
