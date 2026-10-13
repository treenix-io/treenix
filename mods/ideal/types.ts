import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';


/** Board of ideas — container that auto-approves popular ones */
export class IdeasBoard {
  autoApproveThreshold = 5;
}
const declaredIdealBoard = declareClientType('ideal.board', IdeasBoard);

/** A single idea with voting */
export class Idea {
  title = '';
  votes = 0;
  status: 'new' | 'approved' | 'rejected' = 'new';

  upvote() { this.votes++; }

  approve() { this.status = 'approved'; }

  reject() { this.status = 'rejected'; }
}
const declaredIdealIdea = declareClientType('ideal.idea', Idea);

export const clientModules = [declareOpenModule('@treenx/mods/ideal/types', [], [
  declaredIdealBoard,
  declaredIdealIdea,
])];
