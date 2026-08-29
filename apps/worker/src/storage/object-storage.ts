import { createObjectStorage, type ObjectStorage } from '@careos/object-storage';

let objectStorage: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  objectStorage ??= createObjectStorage();
  return objectStorage;
}

export function setObjectStorageForTests(store: ObjectStorage | undefined): void {
  objectStorage = store;
}
