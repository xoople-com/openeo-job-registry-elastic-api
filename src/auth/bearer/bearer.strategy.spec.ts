import { ForbiddenException } from '@nestjs/common';
import { BearerStrategy, VERIFICATION_ERRORS } from './bearer.strategy';
import { CachingService } from '../../caching/services/cache.service';

describe('BearerStrategy', () => {
  const mockClient: any = {
    introspect: (token: string) => Promise<any>,
  };

  const mockCachingService: jest.Mocked<
    Pick<CachingService, 'checkCache' | 'store'>
  > = {
    checkCache: jest.fn(),
    store: jest.fn(),
  };

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
  });

  it('should return an error when there is no client defined', async () => {
    mockCachingService.checkCache.mockResolvedValueOnce(undefined);
    mockCachingService.store.mockResolvedValueOnce(undefined);
    const strategy = new BearerStrategy(null, mockCachingService as any);
    const verified = jest.fn();
    const verifyMock = jest
      .spyOn(mockClient, 'introspect')
      .mockResolvedValueOnce({
        active: true,
      });

    await strategy.verify('token', verified, 3);

    expect(verifyMock).toBeCalledTimes(0);
    expect(verified.mock.calls.length).toEqual(1);
    expect(verified.mock.calls[0]).toEqual([
      VERIFICATION_ERRORS.NO_CLIENT,
      null,
      null,
    ]);
  });

  it('should verify the token', async () => {
    mockCachingService.checkCache.mockResolvedValueOnce(undefined);
    mockCachingService.store.mockResolvedValueOnce(undefined);
    const strategy = new BearerStrategy(mockClient, mockCachingService as any);
    const verified = jest.fn();
    const verifyMock = jest
      .spyOn(mockClient, 'introspect')
      .mockResolvedValueOnce({
        active: true,
      });

    await strategy.verify('token', verified, 3);

    expect(verifyMock).toBeCalledTimes(1);
    expect(verified.mock.calls.length).toEqual(1);
    expect(verified.mock.calls[0]).toEqual([null, {}, null]);
    expect(mockCachingService.store).toBeCalledTimes(1);
  });

  it('should not verify token if not active', async () => {
    mockCachingService.checkCache.mockResolvedValueOnce(undefined);
    const strategy = new BearerStrategy(mockClient, mockCachingService as any);
    const verified = jest.fn();
    const verifyMock = jest.spyOn(mockClient, 'introspect').mockResolvedValue({
      active: false,
    });

    await strategy.verify('token', verified, 3);

    expect(verifyMock).toBeCalledTimes(1);
    expect(verified.mock.calls.length).toEqual(1);
    expect(verified.mock.calls[0]).toEqual([
      null,
      null,
      VERIFICATION_ERRORS.TOKEN_INVALID,
    ]);
    expect(mockCachingService.store).toBeCalledTimes(0);
  });

  it('should not validate the token if an error occurred during the token validation', async () => {
    mockCachingService.checkCache.mockResolvedValueOnce(undefined);
    const strategy = new BearerStrategy(mockClient, mockCachingService as any);
    const verified = jest.fn();
    const verifyMock = jest
      .spyOn(mockClient, 'introspect')
      .mockImplementation(() => {
        throw new Error('Nope!');
      });

    await strategy.verify('token', verified, 3);

    expect(verifyMock).toBeCalledTimes(3);
    expect(verified.mock.calls.length).toEqual(1);
    expect(verified.mock.calls[0]).toEqual([
      VERIFICATION_ERRORS.GENERAL,
      null,
      null,
    ]);
    expect(mockCachingService.store).toBeCalledTimes(0);
  });

  it('should return cached result and skip introspection on cache hit', async () => {
    const cachedResult = { error: null, user: {}, info: null };
    mockCachingService.checkCache.mockResolvedValueOnce(cachedResult);
    const strategy = new BearerStrategy(mockClient, mockCachingService as any);
    const verified = jest.fn();
    const verifyMock = jest.spyOn(mockClient, 'introspect');

    await strategy.verify('token', verified, 3);

    expect(verifyMock).toBeCalledTimes(0);
    expect(mockCachingService.store).toBeCalledTimes(0);
    expect(verified.mock.calls.length).toEqual(1);
    expect(verified.mock.calls[0]).toEqual([null, {}, null]);
  });

  describe('with required roles', () => {
    const buildToken = (payload: any) =>
      [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify(payload)).toString('base64url'),
        'signature',
      ].join('.');

    const payload = {
      sub: '22e2e4bf-4afc-4e2f-829a-248db17c3a15',
      realm_access: {
        roles: ['rw-role', 'offline_access', 'uma_authorization'],
      },
    };

    const verifyWithRoles = async (token: string) => {
      mockCachingService.checkCache.mockResolvedValueOnce(undefined);
      jest.spyOn(mockClient, 'introspect').mockResolvedValue({ active: true });
      const strategy = new BearerStrategy(
        mockClient,
        mockCachingService as any,
        ['rw-role'],
      );
      const warnSpy = jest
        .spyOn(strategy.logger, 'warn')
        .mockImplementation(() => undefined);
      const verified = jest.fn();
      await strategy.verify(token, verified, 3);
      return { verified, warnSpy };
    };

    it('should verify the token when it has one of the required roles', async () => {
      const { verified, warnSpy } = await verifyWithRoles(buildToken(payload));

      expect(verified.mock.calls[0]).toEqual([null, {}, null]);
      expect(mockCachingService.store).toBeCalledTimes(1);
      expect(warnSpy).not.toBeCalled();
    });

    it('should forbid the token when it has none of the required roles', async () => {
      const { verified, warnSpy } = await verifyWithRoles(
        buildToken({
          ...payload,
          realm_access: { roles: ['offline_access', 'uma_authorization'] },
        }),
      );

      expect(mockClient.introspect).toBeCalledTimes(1);
      expect(verified.mock.calls[0][0]).toBeInstanceOf(ForbiddenException);
      expect(verified.mock.calls[0].slice(1)).toEqual([null, null]);
      expect(mockCachingService.store).toBeCalledTimes(0);
      expect(warnSpy).toBeCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(payload.sub);
      expect(warnSpy.mock.calls[0][0]).toContain('rw-role');
    });

    it('should forbid the token when it has no realm roles', async () => {
      const { verified } = await verifyWithRoles(
        buildToken({ sub: payload.sub }),
      );

      expect(verified.mock.calls[0][0]).toBeInstanceOf(ForbiddenException);
      expect(mockCachingService.store).toBeCalledTimes(0);
    });

    it.each([
      'opaque-token',
      'a.not-json.c',
      `a.${Buffer.from('1').toString('base64url')}.c`,
    ])(
      'should forbid a token whose payload cannot be decoded (%s)',
      async (token) => {
        const { verified } = await verifyWithRoles(token);

        expect(verified.mock.calls[0][0]).toBeInstanceOf(ForbiddenException);
        expect(mockCachingService.store).toBeCalledTimes(0);
      },
    );
  });
});
