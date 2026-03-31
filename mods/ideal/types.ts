import { registerType } from '@treenity/core/comp';

export class Idea {
  title = '';
  votes = 0;
  status: 'new' | 'approved' | 'rejected' = 'new';

  upvote() { this.votes++; }

  approve() { this.status = 'approved'; }

  reject() { this.status = 'rejected'; }
}

registerType('ideal.idea', Idea);
