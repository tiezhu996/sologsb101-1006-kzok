/** 并列保留标记：三向合并中双改记录克隆出的副本，列表页据此打「并列保留」标签 */
export interface MergeOriginMark {
  kind: 'duplicate'
  /** 同一组双改记录的归组 id（本机原件与对端副本共享） */
  groupId: string
  origin: 'local' | 'incoming'
  /** 对端班组名 */
  crew?: string
}
