import { before, DELETE, PUT, route } from 'awilix-express';
import IContextContainer from '../context/icontext-container';
import { NextFunction, Request, Response } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { imageUpload, removeUploadedFile, uploadedFileSource } from '../helpers/multer.helper';
import { FileVisibility } from '@prisma/client';
import { updateUsernameValidator } from '../validators/user.validators';
import { validateRequest } from '../middlewares/validate-request';
import { getApiResponse } from '../helpers/http.helper';
import { HttpException } from '../exceptions/http-exception';

@route('/api/users')
export default class UserController {
  constructor(private di: IContextContainer) {}

  @PUT()
  @route('/username')
  @before([authMiddleware, updateUsernameValidator, validateRequest])
  async updateUsername(req: Request<{}, {}, {username:string}>, res: Response, next: NextFunction) {
    try {
      const response = await this.di.UserService.updateUsername(req.body, req.user!);
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/image')
  @before([authMiddleware, imageUpload.single('image')])
  async updateImage(req: Request<{}, {}, {}>, res: Response, next: NextFunction) {
    try {
      if (!req.file) throw new HttpException('Image not found', 400);
      const source = uploadedFileSource(req.file);
      const uploaded = await this.di.StorageService.upload({
        ownerId: req.user!.id,
        filename: req.file.originalname,
        body: source.body,
        size: source.size,
        mime: req.file.mimetype,
        visibility: FileVisibility.public,
        namespace: `avatars/${req.user!.id}`,
        scope: { userId: req.user!.id },
      });
      const response = await this.di.UserService.updateImage(
        { fileId: uploaded.file.id, url: uploaded.url },
        req.user!
      );
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    } finally {
      await removeUploadedFile(req.file);
    }
  }

  @DELETE()
  @route('/')
  @before([authMiddleware])
  async deleteAccount(req: Request<{}, {}, {}>, res: Response, next: NextFunction) {
    try {
      const response = await this.di.UserService.deleteAccount(req.user!);
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
