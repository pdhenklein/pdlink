# pdLink

Live no Discord sem passar pelos servidores do Discord: a imagem vai direto do seu PC para quem esta assistindo, em ate 1080p60, usando a placa de video (NVENC) para comprimir.

- So quem esta **na mesma call** que voce consegue assistir.
- O visual e o do proprio Discord: botao de transmitir, "AO VIVO" ao lado do nome, quadro da live na call e menus de qualidade.
- **Ping e desenho:** quem assiste aponta e desenha na tela de quem transmite (clique com o botao do meio do mouse pinga na hora).
- **Arquivos sem limite de tamanho:** o clipe, a esquerda dos botoes da call, envia arquivos direto de um PC para o outro. Funciona com ou sem live.
- **Ping e desenho:** quem assiste aponta e desenha na tela de quem transmite (clique com o botao do meio do mouse pinga na hora).
- **Arquivos sem limite de tamanho:** o clipe, a esquerda dos botoes da call, envia arquivos direto de um PC para o outro. Funciona com ou sem live.
- Instala **apenas este plugin**, nada mais.

## Como instalar

1. Baixe o `Instalar-pdLink.exe` na [ultima versao](https://github.com/pdhenklein/pdlink/releases/latest).
2. Abra ele e clique em **Sim**. Se o Discord estiver aberto, ele pede para fechar (saia da call antes).
3. Pronto. O Discord abre sozinho com o pdLink.

O Windows pode mostrar um aviso azul ("O Windows protegeu o computador") porque o programa nao e assinado. Clique em **Mais informacoes** e depois em **Executar assim mesmo**.

## Atualizacoes

Sao automaticas. Quando sai uma versao nova, o plugin baixa sozinho e avisa com uma faixa no topo do Discord. A versao nova passa a valer da proxima vez que voce fechar e abrir o Discord (inclusive pela bandeja, perto do relogio).

Quando o proprio Discord se atualiza, o pdLink se reinstala sozinho na versao nova.

## Como remover

Abra o `Instalar-pdLink.exe` de novo e clique em **Nao**. O Discord volta exatamente ao original.

## Requisitos

- Windows 10 ou 11, Discord normal (nao PTB/Canary).
- Para transmitir em 1080p60: placa de video NVIDIA. Para assistir, qualquer PC serve.

## Como funciona (para quem quer saber)

| Parte | O que faz |
|---|---|
| `helper/` | Programa em C++ que captura a tela/janela (Windows Graphics Capture), converte e comprime em H.264 na placa de video (Media Foundation + NVENC) e captura o som do jogo/janela (WASAPI). |
| `plugin/goLiveP2P/` | Plugin do Vencord. Liga o botao de live do Discord ao auxiliar, conecta os PCs direto (WebRTC) e mostra a live dentro da interface do Discord. |
| `package/` | Carregador, instalador e o script que monta cada versao. |
| `vencord-build/` | Os dois scripts de build do Vencord (versao 1.15.16) com a opcao de compilar so este plugin. |

A combinacao de "quem esta ao vivo" passa por um servidor MQTT publico (emqx ou hivemq) so com textos de conexao; o video e o audio nunca passam por la.

Licenca GPL-3.0, como o Vencord.
