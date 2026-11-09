import { IModelContainer } from '../models';
import { IServiceContainer } from '../services/index';

export default interface IContextContainer extends IServiceContainer, IModelContainer {}
