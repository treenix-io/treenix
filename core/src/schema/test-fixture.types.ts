// Test fixture type — used by schema.test.ts to verify schema extraction
// This file is NOT a .test.ts so extract-schemas picks it up
import { registerType } from '#comp';

/** Test fixture with properties and methods */
class TestFixture {
  /** @title Name */
  name = '';
  /** @title Count */
  count = 0;

  rename(data: { newName: string }) {
    this.name = data.newName;
  }

  clear() {
    this.name = '';
    this.count = 0;
  }
}
registerType('test.fixture', TestFixture);
