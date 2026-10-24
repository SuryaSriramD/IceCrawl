import { MemoryStore } from '../src/store/memory';
import { describeStoreContract } from './store.contract';

describeStoreContract('memory', async () => new MemoryStore());
