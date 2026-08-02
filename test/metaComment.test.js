'use strict';
// metaComment.test.js — extractComment: parsing puro do comentário (IG 'comments' / FB 'feed').
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractComment } = require('../src/metaIngest');

test('(1) FB feed: comentário novo (item=comment, verb=add)', () => {
  const r = extractComment('feed', {
    item: 'comment', verb: 'add', comment_id: '111_222', post_id: '111_000',
    parent_id: '111_000', from: { id: 'U1', name: 'Maria' }, message: 'Tem aula de bateria?',
  });
  assert.equal(r.channel, 'facebook_comment');
  assert.equal(r.commentId, '111_222');
  assert.equal(r.authorId, 'U1');
  assert.equal(r.authorName, 'Maria');
  assert.equal(r.text, 'Tem aula de bateria?');
  assert.equal(r.postId, '111_000');
});

test('(2) IG comments: comentário', () => {
  const r = extractComment('comments', {
    id: 'IGC1', text: 'Qual o valor?', from: { id: 'IGU1', username: 'maria.rock' }, media: { id: 'MEDIA1' },
  });
  assert.equal(r.channel, 'instagram_comment');
  assert.equal(r.commentId, 'IGC1');
  assert.equal(r.authorId, 'IGU1');
  assert.equal(r.authorName, 'maria.rock');
  assert.equal(r.text, 'Qual o valor?');
  assert.equal(r.mediaId, 'MEDIA1');
});

test('(3) FB feed: curtida (item != comment) -> null', () => {
  assert.equal(extractComment('feed', { item: 'reaction', verb: 'add', from: { id: 'U1' } }), null);
});

test('(4) FB feed: comentário removido/editado (verb != add) -> null', () => {
  assert.equal(extractComment('feed', { item: 'comment', verb: 'remove', comment_id: 'X', from: { id: 'U1' } }), null);
  assert.equal(extractComment('feed', { item: 'comment', verb: 'edited', comment_id: 'X', from: { id: 'U1' } }), null);
});

test('(5) FB feed: sem from -> null', () => {
  assert.equal(extractComment('feed', { item: 'comment', verb: 'add', comment_id: 'X' }), null);
});

test('(6) IG comments: sem id -> null', () => {
  assert.equal(extractComment('comments', { text: 'oi', from: { id: 'U1' } }), null);
});

test('(7) campo desconhecido -> null', () => {
  assert.equal(extractComment('ratings', { id: 'X' }), null);
  assert.equal(extractComment('feed', {}), null);
});
