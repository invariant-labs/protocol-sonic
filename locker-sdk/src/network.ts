export enum Network {
  LOCAL,
  DEV,
  TEST,
  MAIN
}

export const getLockerAddress = (network: Network) => {
  switch (network) {
    case Network.LOCAL:
      return '34CS5UnQfoNmJ2MUgBc2VuM3BYFv7oYJTbEsbKrp3Zia'
    case Network.TEST:
      return '34CS5UnQfoNmJ2MUgBc2VuM3BYFv7oYJTbEsbKrp3Zia'
    case Network.DEV:
      return '34CS5UnQfoNmJ2MUgBc2VuM3BYFv7oYJTbEsbKrp3Zia'
    case Network.MAIN:
      return 'LockDkUjGpMHewP4cbP7XRpiiC4ciQaPALbwUALCEJp'
    default:
      throw new Error('Unknown network')
  }
}
