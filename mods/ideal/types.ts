import { registerType } from '@treenx/core/comp';

/** Board of ideas — container that auto-approves popular ones */
export class IdeasBoard {
  autoApproveThreshold = 5;
}
registerType('ideal.board', IdeasBoard);

/** A single idea with voting */
export class Idea {
  title = '';
  votes = 0;
  status: 'new' | 'approved' | 'rejected' = 'new';

  upvote() { this.votes++; }

  approve() { this.status = 'approved'; }

  reject() { this.status = 'rejected'; }
}
registerType('ideal.idea', Idea);
