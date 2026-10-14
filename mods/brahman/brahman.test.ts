import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReplyMarkup, checkTags, formatTString, renderTemplate } from './helpers';
import type { MenuRow } from './types';

describe('brahman template engine', () => {
  it('formatTString: exact lang', () => {
    assert.equal(formatTString({ en: 'Hello', ru: 'Привет' }, 'en'), 'Hello');
    assert.equal(formatTString({ en: 'Hello', ru: 'Привет' }, 'ru'), 'Привет');
  });

  it('formatTString: fallback chain', () => {
    assert.equal(formatTString({ ru: 'Только ру' }, 'de'), 'Только ру');
    assert.equal(formatTString({ en: 'Only en' }, 'de'), 'Only en');
    assert.equal(formatTString({ fr: 'Bonjour' }, 'de'), 'Bonjour');
  });

  it('formatTString: empty/undefined', () => {
    assert.equal(formatTString(undefined, 'en'), '');
    assert.equal(formatTString({}, 'en'), '');
  });

  it('renderTemplate: simple interpolation', () => {
    assert.equal(renderTemplate('{name}', { name: 'Bob' }), 'Bob');
    assert.equal(renderTemplate('Hi {{name}}!', { name: 'Alice' }), 'Hi Alice!');
  });

  it('renderTemplate: dot-path', () => {
    assert.equal(renderTemplate('{user.firstName}', { user: { firstName: 'Test' } }), 'Test');
  });

  it('renderTemplate: ifEquals', () => {
    const tpl = '{{#ifEquals lang "en"}}English{{else}}Other{{/ifEquals}}';
    assert.equal(renderTemplate(tpl, { lang: 'en' }), 'English');
    assert.equal(renderTemplate(tpl, { lang: 'ru' }), 'Other');
  });

  it('renderTemplate: tag helper', () => {
    const tpl = '{{#tag admin}}Admin content{{else}}Normal{{/tag}}';
    assert.equal(renderTemplate(tpl, { userTags: ['admin'] }), 'Admin content');
    assert.equal(renderTemplate(tpl, { userTags: [] }), 'Normal');
  });

  it('renderTemplate: eval', () => {
    assert.equal(renderTemplate('{{eval 2 + 3}}', {}), '5');
    assert.equal(renderTemplate('{{eval data.x * 2}}', { x: 10 }), '20');
  });

  it('renderTemplate: toFixed', () => {
    assert.equal(renderTemplate('{{toFixed price 2}}', { price: 3.14159 }), '3.14');
  });

  it('renderTemplate: is', () => {
    assert.equal(renderTemplate('{{is active}}', { active: true }), 'true');
    assert.equal(renderTemplate('{{is active}}', { active: false }), '');
  });

  it('renderTemplate: switch', () => {
    assert.equal(renderTemplate('{{switch lang ru Привет en Hello}}', { lang: 'en' }), 'Hello');
    assert.equal(renderTemplate('{{switch lang ru Привет en Hello}}', { lang: 'ru' }), 'Привет');
    assert.equal(renderTemplate('{{switch lang ru Привет en Hello}}', { lang: 'de' }), '');
  });
});

describe('brahman checkTags', () => {
  it('empty tags = always show', () => {
    assert.ok(checkTags([], []));
    assert.ok(checkTags(['admin'], []));
  });

  it('include tags (OR logic)', () => {
    assert.ok(checkTags(['admin'], ['admin']));
    assert.ok(checkTags(['admin', 'vip'], ['vip']));
    assert.ok(!checkTags([], ['admin']));
    assert.ok(!checkTags(['user'], ['admin']));
  });

  it('exclude tags (!prefix)', () => {
    assert.ok(checkTags([], ['!banned']));
    assert.ok(!checkTags(['banned'], ['!banned']));
  });

  it('mixed include + exclude', () => {
    assert.ok(checkTags(['admin'], ['admin', '!banned']));
    assert.ok(!checkTags(['admin', 'banned'], ['admin', '!banned']));
    assert.ok(!checkTags(['banned'], ['admin', '!banned']));
  });
});

describe('brahman buildReplyMarkup', () => {
  const rows: MenuRow[] = [
    {
      buttons: [
        { id: 1, title: { en: 'Btn1' }, action: { type: 'brahman.action.page', target: '/p1' } },
        { id: 2, title: { en: 'Btn2' }, url: 'https://example.com' },
      ],
    },
  ];

  it('none returns undefined', () => {
    assert.equal(buildReplyMarkup(rows, 'none', 'en'), undefined);
  });

  it('remove returns remove_keyboard', () => {
    const r = buildReplyMarkup(rows, 'remove', 'en') as any;
    assert.ok(r.reply_markup.remove_keyboard);
  });

  it('force_reply returns force_reply', () => {
    const r = buildReplyMarkup(rows, 'force_reply', 'en') as any;
    assert.ok(r.reply_markup.force_reply);
  });

  it('keyboard builds reply keyboard', () => {
    const r = buildReplyMarkup(rows, 'keyboard', 'en') as any;
    assert.ok(r.reply_markup);
  });

  it('inline builds inline keyboard', () => {
    const r = buildReplyMarkup(rows, 'inline', 'en') as any;
    assert.ok(r.reply_markup);
  });

  it('filters by tags', () => {
    const taggedRows: MenuRow[] = [
      {
        buttons: [
          { id: 1, title: { en: 'Admin only' }, tags: ['admin'] },
          { id: 2, title: { en: 'Public' } },
        ],
      },
    ];
    // non-admin: only Public button should remain
    const r = buildReplyMarkup(taggedRows, 'keyboard', 'en', []) as any;
    assert.ok(r.reply_markup);
    const kbText = JSON.stringify(r.reply_markup);
    assert.ok(kbText.includes('Public'), 'should include Public button');
    assert.ok(!kbText.includes('Admin only'), 'should exclude Admin only button');
  });
});
