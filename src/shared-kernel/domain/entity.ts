/**
 * Base Entity. Identity-based equality: two entities are equal when their
 * ids match, regardless of their other attributes.
 */
export abstract class Entity<Id> {
  protected readonly _id: Id;

  protected constructor(id: Id) {
    this._id = id;
  }

  get id(): Id {
    return this._id;
  }

  equals(other?: Entity<Id>): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (this === other) {
      return true;
    }
    return this._id === other._id;
  }
}
