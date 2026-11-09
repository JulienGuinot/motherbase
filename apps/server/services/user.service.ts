import crypto from 'crypto';
import type { User } from '@prisma/client';
import BaseContext from '../context/base-context';
import { randomNumber } from '../helpers/utils.helper';
import { HttpException } from '../exceptions/http-exception';

/** The subset of a user row that is safe to hand back to its own owner. */
function toPublicUser(user: User) {
  return {
    id: user.id,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    username: user.username ?? undefined,
    imageUrl: user.imageUrl ?? undefined,
  };
}

const RandomPrefixes = [
  'SkyWalker',
  'PixelPirate',
  'MysticMuse',
  'QuantumQuokka',
  'CosmicComet',
  'NebulaKnight',
  'CyberSphinx',
  'StellarStarlight',
  'AstroArcher',
  'VortexVoyager',
  'GalaxyGazer',
  'LunarLioness',
  'HyperHawk',
  'NovaNinja',
  'PhotonPhoenix',
  'TitanThunder',
  'OrbitOracle',
  'CometCrafter',
  'StarStrider',
  'ZenithZephyr',
  'NeonNomad',
  'CipherShadow',
  'GlitchGhost',
  'DataDrifter',
  'BinaryBard',
  'NanoNinja',
  'EchoEngine',
  'PulsePioneer',
  'VectorViking',
  'RogueRider',
  'FrostForge',
  'BlazeBot',
  'IronInk',
  'ShadowShard',
  'VoidViper',
  'StormScribe',
  'ArcaneAce',
  'PrismPilot',
  'FluxFalcon',
  'DriftDaemon',
];

/** Database lookups spent looking for a free username before giving up on checking. */
const MAX_USERNAME_ATTEMPTS = 8;
/** Suffix width for the unchecked last resort. */
const FALLBACK_SUFFIX_DIGITS = 8;

export class UserService extends BaseContext {
  
  async usernameExists(username: string) {
    const user = await this.di.prisma.user.findUnique({ where: { username } });
    return Boolean(user);
  }

  generateUsername(suffixLength?: number) {
    const suffix = suffixLength ? randomNumber(suffixLength).toString() : '';
    const starIndex = crypto.randomInt(RandomPrefixes.length);
    return `${RandomPrefixes[starIndex]}${suffix}`;
  }

  /**
   * A free username: a bare prefix when one is available, then a growing numeric
   * suffix. Bounded on purpose. The loop queries the database once per attempt,
   * so an exhausted name space (or a database answering slowly) must not turn a
   * sign-up into an unbounded read loop.
   *
   * The last candidate is returned WITHOUT a lookup: every check here is a read
   * before an insert that happens elsewhere, so a concurrent sign-up can always
   * take the name we just cleared. A wide random suffix makes that final
   * collision improbable, and the unique index remains the real arbiter.
   */
  async getRandomUsername() {
    for (let suffixLength = 0; suffixLength < MAX_USERNAME_ATTEMPTS; suffixLength++) {
      const username = this.generateUsername(suffixLength);
      if (!(await this.usernameExists(username))) {
        return { data: { username }, message: 'New username generated successfully' };
      }
    }

    return {
      data: { username: this.generateUsername(FALLBACK_SUFFIX_DIGITS) },
      message: 'New username generated successfully',
    };
  }

  async updateUsername(dto: {username:string}, user: Express.User) {
    const newUser = await this.di.prisma.user.update({
      where: { id: user.id },
      data: { username: dto.username },
    });
    if (!newUser) throw new HttpException('Error updating your profile, please try again later.', 302);
    return { data: toPublicUser(newUser), message: 'Username updated successfully.' };
  }

  async updateImage(image: { fileId: string; url: string | null }, user: Express.User) {
    try {
      if (!image.url) throw new HttpException('The uploaded profile image is not readable.', 403);
      const current = await this.di.prisma.user.findUnique({
        where: { id: user.id },
        select: { imageUrl: true },
      });
      const newUser = await this.di.prisma.user.update({
        where: { id: user.id },
        data: { imageUrl: image.url },
      });
      if (!newUser) throw new HttpException('Error updating your profile, please try again later.', 302);

      if (current?.imageUrl && current.imageUrl !== image.url) {
        await this.removeStoredAvatar(current.imageUrl, user.id).catch(() => undefined);
      }
      return { data: toPublicUser(newUser), message: 'Profile image updated successfully.' };
    } catch (error: unknown) {
      await this.di.StorageService.remove(image.fileId, { userId: user.id }).catch(() => undefined);
      throw error;
    }
  }

  private async removeStoredAvatar(url: string, userId: string): Promise<void> {
    const file = await this.di.prisma.file.findFirst({
      where: {
        ownerId: userId,
        url,
        key: { startsWith: `avatars/${userId}/` },
      },
      select: { id: true },
    });
    if (file) await this.di.StorageService.remove(file.id, { userId });
  }

  async deleteAccount(user: Express.User) {
    // Better Auth sessions/accounts cascade on user delete (FK onDelete: Cascade).
    await this.di.prisma.user.delete({ where: { id: user.id } });
    return { data: { isDeleted: true }, message: 'Account deleted successfully.' };
  }
}
